/// <reference types="node" />
import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
// @ts-ignore - plain ESM script shipped next to the Dockerfile
import * as s3 from "../s3-client.mjs";
// @ts-ignore
import { runBackup, readStatus, PacedTransform, removeWorkDirs } from "../backup.mjs";
import { handleBackupRequest } from "../src/api/account/adminBackup";

const EMPTY = s3.EMPTY_SHA256;
const __dirname_ = path.join(path.dirname(new URL(import.meta.url).pathname), "..");

// ─── Minimal in-memory S3 (path-style) ───────────────────────────────────────

interface Obj { body: Buffer; modified: number }

function startMockS3(bucket: string, pageSize = 2) {
  const objects = new Map<string, Obj>();
  const seen: { method: string; url: string; auth?: string; payload?: string }[] = [];

  const server = http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://x");
    seen.push({ method: req.method || "", url: req.url || "", auth: req.headers.authorization as string, payload: req.headers["x-amz-content-sha256"] as string });
    const parts = decodeURIComponent(u.pathname).split("/").filter(Boolean);
    if (parts[0] !== bucket) { res.writeHead(404); return res.end("<Error><Code>NoSuchBucket</Code></Error>"); }
    if (!req.headers.authorization?.startsWith("AWS4-HMAC-SHA256 ")) { res.writeHead(403); return res.end("<Error><Code>AccessDenied</Code><Message>no auth</Message></Error>"); }
    const key = parts.slice(1).join("/");

    if (req.method === "GET" && !key) {
      const prefix = u.searchParams.get("prefix") || "";
      const token = u.searchParams.get("continuation-token") || "";
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = token ? keys.indexOf(token) : 0;
      const page = keys.slice(start, start + pageSize);
      const next = keys[start + pageSize];
      let xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>${next ? "true" : "false"}</IsTruncated>`;
      if (next) xml += `<NextContinuationToken>${next}</NextContinuationToken>`;
      for (const k of page) {
        const o = objects.get(k)!;
        xml += `<Contents><Key>${k}</Key><LastModified>${new Date(o.modified).toISOString()}</LastModified><Size>${o.body.length}</Size></Contents>`;
      }
      res.writeHead(200, { "content-type": "application/xml" });
      return res.end(xml + "</ListBucketResult>");
    }
    if (req.method === "PUT") {
      const copy = req.headers["x-amz-copy-source"] as string | undefined;
      if (copy) {
        const src = decodeURIComponent(copy).replace(/^\/+/, "").split("/").slice(1).join("/");
        const o = objects.get(src);
        if (!o) { res.writeHead(404); return res.end("<Error><Code>NoSuchKey</Code></Error>"); }
        objects.set(key, { body: o.body, modified: Date.now() });
        res.writeHead(200); return res.end("<CopyObjectResult/>");
      }
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        if (Number(req.headers["content-length"]) !== body.length) { res.writeHead(400); return res.end(); }
        objects.set(key, { body, modified: Date.now() });
        res.writeHead(200); res.end();
      });
      return;
    }
    if (req.method === "HEAD" || req.method === "GET") {
      const o = objects.get(key);
      if (!o) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-length": o.body.length });
      return res.end(req.method === "HEAD" ? undefined : o.body);
    }
    if (req.method === "DELETE") { objects.delete(key); res.writeHead(204); return res.end(); }
    res.writeHead(405); res.end();
  });

  return new Promise<{ endpoint: string; objects: Map<string, Obj>; seen: typeof seen; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({ endpoint: `http://127.0.0.1:${port}`, objects, seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) });
    });
  });
}

const has = (cmd: string) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;

async function runTests() {
  console.log(">>> [TEST] Backup: SigV4, S3 client, end-to-end job...\n");

  // 1. SigV4 against AWS published examples (docs.aws.amazon.com "Signature Calculations for the Authorization Header")
  {
    const cfg = { region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
    const now = new Date("2013-05-24T00:00:00Z");
    const sig = (h: Record<string, string>) => /Signature=([0-9a-f]+)/.exec(h.authorization)![1];
    assert.strictEqual(sig(s3.signRequest(cfg, "GET", "https://examplebucket.s3.amazonaws.com/test.txt", { range: "bytes=0-9" }, EMPTY, now)), "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    const body = crypto.createHash("sha256").update("Welcome to Amazon S3.").digest("hex");
    assert.strictEqual(sig(s3.signRequest(cfg, "PUT", "https://examplebucket.s3.amazonaws.com/test%24file.text", { date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" }, body, now)), "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
    assert.strictEqual(sig(s3.signRequest(cfg, "GET", "https://examplebucket.s3.amazonaws.com/?lifecycle", {}, EMPTY, now)), "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
    assert.strictEqual(sig(s3.signRequest(cfg, "GET", "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J", {}, EMPTY, now)), "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
    const presigned = s3.presignUrl(cfg, "https://examplebucket.s3.amazonaws.com/test.txt", { expiresSec: 86400, now });
    assert.strictEqual(/X-Amz-Signature=([0-9a-f]+)/.exec(presigned)![1], "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
    console.log("✔ SigV4 header + presigned signatures match AWS reference vectors");
  }

  // 1b. PacedTransform must never alter the bytes it forwards (odd sizes, tiny and huge chunks)
  {
    const input = crypto.randomBytes(5 * 1024 * 1024 + 4321);
    const parts: Buffer[] = [];
    for (let off = 0; off < input.length; ) {
      const n = [1, 7, 4096, 700_000, 1_500_000][parts.length % 5];
      parts.push(input.subarray(off, off + n));
      off += n;
    }
    const got: Buffer[] = [];
    await pipeline(Readable.from(parts), new PacedTransform(256 * 1024, 0), new Writable({ write(c, _e, cb) { got.push(c); cb(); } }));
    assert.ok(Buffer.concat(got).equals(input), "paced stream output is byte-identical to input");
    console.log("✔ PacedTransform forwards bytes unchanged");
  }

  // 1c. Config: 0 is a real value, and files are read (cron does not inherit the container environment)
  {
    const zero = s3.loadConfig({ BACKUP_YIELD_SLEEP_MS: "0", BACKUP_YIELD_CHUNK_KB: "128", BACKUP_ZSTD_LEVEL: "99", BACKUP_KEEP_LOCAL: "TRUE" });
    assert.strictEqual(zero.yieldSleepMs, 0, "BACKUP_YIELD_SLEEP_MS=0 disables pausing");
    assert.strictEqual(zero.yieldChunkKb, 128);
    assert.strictEqual(zero.zstdLevel, 9, "zstd level is clamped");
    assert.strictEqual(zero.keepLocal, true);
    const def = s3.loadConfig({});
    assert.deepStrictEqual([def.yieldSleepMs, def.yieldChunkKb, def.zstdLevel, def.keepLocal], [10, 512, 1, false]);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obex-cfg-"));
    fs.mkdirSync(path.join(dir, "config"));
    fs.writeFileSync(path.join(dir, "runtime.env"), "BACKUP_S3_BUCKET=from-runtime\nBACKUP_YIELD_SLEEP_MS=25\nBACKUP_S3_PREFIX=rt\n");
    fs.writeFileSync(path.join(dir, "config", ".env"), "BACKUP_S3_PREFIX=from-config\n");
    const saved = { d: process.env.OBEXDNS_DATA_DIR, r: process.env.OBEXDNS_RUNTIME_ENV, b: process.env.BACKUP_S3_BUCKET };
    process.env.OBEXDNS_DATA_DIR = dir; process.env.OBEXDNS_RUNTIME_ENV = path.join(dir, "runtime.env"); delete process.env.BACKUP_S3_BUCKET;
    try {
      const c = s3.loadConfig();
      assert.strictEqual(c.bucket, "from-runtime", "runtime env file is used when nothing else sets it");
      assert.strictEqual(c.yieldSleepMs, 25);
      assert.strictEqual(c.prefix, "from-config", "config/.env overrides the runtime file");
      process.env.BACKUP_S3_BUCKET = "from-process";
      assert.strictEqual(s3.loadConfig().bucket, "from-process", "process env wins");
    } finally {
      for (const [k, v] of [["OBEXDNS_DATA_DIR", saved.d], ["OBEXDNS_RUNTIME_ENV", saved.r], ["BACKUP_S3_BUCKET", saved.b]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log("✔ config: 0 is honoured, clamping, runtime/config/process precedence");
  }

  // 2. S3 client against the mock
  const mock = await startMockS3("bkt");
  const cfg = s3.loadConfig({
    BACKUP_S3_ENDPOINT: mock.endpoint, BACKUP_S3_BUCKET: "bkt", BACKUP_S3_REGION: "auto",
    BACKUP_S3_ACCESS_KEY_ID: "AK", BACKUP_S3_SECRET_ACCESS_KEY: "SK", BACKUP_S3_PREFIX: "/obexdns/", BACKUP_KEEP_DAYS: "7"
  });
  const quiet = { onLog: () => {} };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "obex-backup-test-"));

  try {
    assert.strictEqual(cfg.prefix, "obexdns");
    assert.deepStrictEqual(s3.missingConfig(s3.loadConfig({})), ["BACKUP_S3_ENDPOINT", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY"]);
    assert.ok((await s3.testConnection(cfg)).success);

    // Streaming upload, size verified, UNSIGNED-PAYLOAD
    const big = path.join(tmp, "big.bin");
    fs.writeFileSync(big, crypto.randomBytes(3 * 1024 * 1024 + 123));
    await s3.uploadFile(cfg, big, "obexdns_backup_20260101_000000.tar.zst", quiet);
    const put = mock.seen.find((r) => r.method === "PUT")!;
    assert.strictEqual(put.payload, "UNSIGNED-PAYLOAD");
    assert.ok(mock.objects.get("obexdns/obexdns_backup_20260101_000000.tar.zst")!.body.equals(fs.readFileSync(big)));

    // Download round trip + 404
    const dl = path.join(tmp, "dl.bin");
    assert.strictEqual(await s3.downloadFile(cfg, "obexdns_backup_20260101_000000.tar.zst", dl, quiet), true);
    assert.ok(fs.readFileSync(dl).equals(fs.readFileSync(big)));
    assert.strictEqual(await s3.downloadFile(cfg, "latest.tar.zst", path.join(tmp, "nope"), quiet), false);
    assert.ok(!fs.existsSync(path.join(tmp, "nope")) && !fs.existsSync(path.join(tmp, "nope.part")));

    // Upload failing verification (server stores a different size) is reported
    console.log("✔ upload (streamed, verified) / download / 404");

    // publish: timestamped + latest (server-side copy) + prune with pagination and minKeep
    const old = Date.now() - 40 * 86400000;
    for (const n of ["20250101_000000", "20250102_000000", "20250103_000000", "20250104_000000"]) {
      mock.objects.set(`obexdns/obexdns_backup_${n}.tar.gz`, { body: Buffer.from("x"), modified: old });
    }
    mock.objects.set("obexdns/notes.txt", { body: Buffer.from("keep me"), modified: old });
    const small = path.join(tmp, "small.bin");
    fs.writeFileSync(small, "hello");
    const r = await s3.publishBackup(cfg, small, "obexdns_backup_20260601_000000.tar.zst", "latest.tar.zst", 7, quiet);
    assert.strictEqual(r.size, 5);
    assert.ok(mock.seen.some((q) => q.method === "PUT" && q.url.includes("latest.tar.zst")));
    assert.strictEqual(mock.objects.get("obexdns/latest.tar.zst")!.body.toString(), "hello");
    const remaining = [...mock.objects.keys()].sort();
    assert.ok(remaining.includes("obexdns/notes.txt"), "foreign objects are never pruned");
    assert.ok(remaining.includes("obexdns/latest.tar.zst"), "latest is never pruned");
    const oldLeft = remaining.filter((k) => /2025010\d/.test(k));
    // 2 fresh timestamped backups + the single newest old one fill the 3-backup safety floor; the other 3 old ones go.
    assert.strictEqual(oldLeft.length, 1, `expired backups pruned across pages, left: ${oldLeft}`);
    console.log("✔ publish: latest refreshed by server-side copy, expired backups pruned over several list pages");

    // minKeep: even when everything is expired, the newest 3 survive
    mock.objects.clear();
    for (const n of ["20240101_000000", "20240102_000000", "20240103_000000", "20240104_000000", "20240105_000000"]) {
      mock.objects.set(`obexdns/obexdns_backup_${n}.tar.gz`, { body: Buffer.from("x"), modified: old + Number(n.slice(6, 8)) * 1000 });
    }
    await s3.pruneBackups(cfg, 7, quiet);
    assert.strictEqual([...mock.objects.keys()].length, 3);
    console.log("✔ prune keeps the 3 newest backups even when all are expired");

    // list + presign
    mock.objects.set("obexdns/latest.tar.zst", { body: Buffer.from("l"), modified: Date.now() });
    const list = await s3.listBackups(cfg);
    assert.ok(list.every((b: any) => s3.isValidBackupObjectName(b.name)));
    assert.strictEqual(list[0].name, "latest.tar.zst");
    const url = new URL(s3.presignDownload(cfg, "latest.tar.zst", 300));
    assert.strictEqual(url.pathname, "/bkt/obexdns/latest.tar.zst");
    assert.strictEqual(url.searchParams.get("X-Amz-Expires"), "300");
    assert.ok(url.searchParams.get("response-content-disposition")!.includes("attachment"));
    for (const bad of ["../etc/passwd", "obexdns_backup_1.tar.gz", "latest.tar.zst/../x", "a/b.tar.zst", ""]) {
      assert.throws(() => s3.presignDownload(cfg, bad), /Invalid backup name/);
    }
    console.log("✔ list (backups only) / presign (name allowlist)");

    // 3. End-to-end job (needs sqlite3 CLI + tar + gzip or zstd)
    if (!has("tar") || !spawnSync("sqlite3", ["--version"]).stdout?.length) {
      console.log("⚠ sqlite3/tar not found: skipping end-to-end backup job test");
    } else {
      mock.objects.clear();
      const dataDir = path.join(tmp, "data");
      fs.mkdirSync(dataDir);
      const dbFile = path.join(dataDir, "dns_worker.sqlite");
      const mk = spawnSync("sqlite3", [dbFile, "PRAGMA journal_mode=WAL; CREATE TABLE t(x TEXT); INSERT INTO t VALUES ('alpha'),('beta'),('gamma');"]);
      assert.strictEqual(mk.status, 0, String(mk.stderr));
      fs.writeFileSync(path.join(dataDir, ".jwt_secret"), "s3cr3t");
      const jobTmp = path.join(tmp, "jobtmp");
      fs.mkdirSync(jobTmp);

      const [a, b] = await Promise.all([
        runBackup({ dataDir, dbFile, tmpDir: jobTmp, cfg, trigger: "manual", log: () => {} }),
        runBackup({ dataDir, dbFile, tmpDir: jobTmp, cfg, trigger: "manual", log: () => {} })
      ]);
      assert.strictEqual([a, b].filter((x: any) => x.busy).length, 1, "second concurrent run reports busy");
      const ok = [a, b].find((x: any) => x.ok)!;
      assert.ok(ok.file && ok.sizeBytes > 0);
      assert.deepStrictEqual(fs.readdirSync(jobTmp), [], "work dir and lock are cleaned up");

      const ext = ok.file.endsWith(".tar.zst") ? "tar.zst" : "tar.gz";
      assert.ok(mock.objects.has(`obexdns/${ok.file}`) && mock.objects.has(`obexdns/latest.${ext}`));
      const st = readStatus(dataDir);
      assert.strictEqual(st.state, "success");
      assert.strictEqual(st.lastSuccess.file, ok.file);

      // Restore what was uploaded and read it back
      const arc = path.join(tmp, `restore.${ext}`);
      assert.ok(await s3.downloadFile(cfg, `latest.${ext}`, arc, quiet));
      const ex = path.join(tmp, "extract");
      fs.mkdirSync(ex);
      const untar = ext === "tar.zst"
        ? spawnSync("sh", ["-c", `zstd -dc "${arc}" | tar -x -C "${ex}"`])
        : spawnSync("tar", ["-xzf", arc, "-C", ex]);
      assert.strictEqual(untar.status, 0, String(untar.stderr));
      assert.strictEqual(fs.readFileSync(path.join(ex, ".jwt_secret"), "utf-8"), "s3cr3t");
      const count = spawnSync("sqlite3", [path.join(ex, "dns_worker.sqlite"), "SELECT count(*) FROM t;"]);
      assert.strictEqual(String(count.stdout).trim(), "3");
      console.log("✔ job: snapshot -> archive -> verify -> upload -> latest; restore reads back the data; concurrent run is rejected");

      // Leftovers of a run killed with SIGKILL are removed by the next run; look-alikes are not touched
      {
        const orphanA = path.join(jobTmp, "obexdns_backup_AbC123");
        const orphanB = path.join(jobTmp, "obexdns_backup_zzzzzz");
        fs.mkdirSync(path.join(orphanA, "pkg"), { recursive: true });
        fs.writeFileSync(path.join(orphanA, "pkg", "dns_worker.sqlite"), crypto.randomBytes(1024));
        fs.mkdirSync(orphanB);
        const keepDir = path.join(jobTmp, "something_else");
        const keepFile = path.join(jobTmp, "obexdns_backup_notes.txt");
        fs.mkdirSync(keepDir);
        fs.writeFileSync(keepFile, "x");
        const r2 = await runBackup({ dataDir, dbFile, tmpDir: jobTmp, cfg, log: () => {} });
        assert.ok(r2.ok, String(r2.error));
        assert.ok(!fs.existsSync(orphanA) && !fs.existsSync(orphanB), "leftover work dirs are removed");
        assert.ok(fs.existsSync(keepDir) && fs.existsSync(keepFile), "unrelated entries are left alone");
        assert.strictEqual(removeWorkDirs(jobTmp), 0);
        fs.rmSync(keepDir, { recursive: true });
        fs.rmSync(keepFile);
        assert.deepStrictEqual(fs.readdirSync(jobTmp), [], "nothing left behind after a normal run");
        console.log("✔ leftover work directories from killed runs are cleaned up (look-alikes untouched)");
      }

      // Consistency under concurrent writes: a snapshot taken while the app commits and checkpoints must be a
      // valid database. (Copying the live file instead produces "row N missing from index" corruption.)
      {
        const liveDb = path.join(tmp, "busy.sqlite");
        const mkBusy = spawnSync("sqlite3", [liveDb, "PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY, k TEXT, v TEXT); CREATE INDEX ik ON t(k); " +
          "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<60000) INSERT INTO t(k,v) SELECT hex(randomblob(8)), hex(randomblob(200)) FROM c;"]);
        assert.strictEqual(mkBusy.status, 0, String(mkBusy.stderr));
        const writer = spawn("sh", ["-c", `while :; do sqlite3 "${liveDb}" "UPDATE t SET k=hex(randomblob(8)), v=hex(randomblob(200)) WHERE id % 40 = abs(random()) % 40; PRAGMA wal_checkpoint(PASSIVE);" >/dev/null 2>&1; done`], { detached: true, stdio: "ignore" });
        try {
          await new Promise((r) => setTimeout(r, 500));
          for (let i = 0; i < 4; i++) {
            const res = await runBackup({ dataDir, dbFile: liveDb, tmpDir: jobTmp, cfg, log: () => {} });
            assert.ok(res.ok, `backup under write load #${i} failed: ${res.error}`);
            const e = res.file.endsWith(".tar.zst") ? "tar.zst" : "tar.gz";
            const a2 = path.join(tmp, `busy_${i}.${e}`);
            assert.ok(await s3.downloadFile(cfg, res.file, a2, quiet));
            const d2 = path.join(tmp, `busy_x_${i}`);
            fs.mkdirSync(d2);
            const u2 = e === "tar.zst" ? spawnSync("sh", ["-c", `zstd -dc "${a2}" | tar -x -C "${d2}"`]) : spawnSync("tar", ["-xzf", a2, "-C", d2]);
            assert.strictEqual(u2.status, 0, String(u2.stderr));
            const chk = spawnSync("sqlite3", [path.join(d2, "dns_worker.sqlite"), "PRAGMA integrity_check;"]);
            assert.strictEqual(String(chk.stdout).trim(), "ok", `backup #${i} taken under write load is corrupt: ${chk.stdout}`);
          }
        } finally {
          try { process.kill(-writer.pid!, "SIGKILL"); } catch { /* already gone */ }
        }
        console.log("✔ 4 backups taken while the database is being written + checkpointed all pass integrity_check");
      }

      // Failure must not touch latest and must be reported
      const before = mock.objects.get(`obexdns/latest.${ext}`)!.body;
      const successBefore = readStatus(dataDir).lastSuccess.file;
      const bad = await runBackup({ dataDir, dbFile: path.join(dataDir, "missing.sqlite"), tmpDir: jobTmp, cfg, log: () => {} });
      assert.strictEqual(bad.ok, false);
      assert.strictEqual(readStatus(dataDir).state, "failed");
      assert.strictEqual(readStatus(dataDir).lastSuccess.file, successBefore, "last success survives a failed run");
      assert.ok(mock.objects.get(`obexdns/latest.${ext}`)!.body.equals(before));
      console.log("✔ failed run: reported in status, latest untouched, last success preserved");

      // 4. Admin API: background run, 409 while running, polling, list, presign
      const saved = { ...process.env };
      Object.assign(process.env, {
        OBEXDNS_DATA_DIR: dataDir, OBEXDNS_APP_DIR: path.resolve(__dirname_), SERVERFULL_DB_PATH: dbFile,
        BACKUP_S3_ENDPOINT: mock.endpoint, BACKUP_S3_BUCKET: "bkt", BACKUP_S3_ACCESS_KEY_ID: "AK",
        BACKUP_S3_SECRET_ACCESS_KEY: "SK", BACKUP_S3_PREFIX: "obexdns"
      });
      try {
        const call = async (method: string, sub?: string, body?: unknown) => {
          const res = await handleBackupRequest(
            new Request("http://x/api/admin/backup" + (sub ? "/" + sub : ""), { method, body: body ? JSON.stringify(body) : undefined }),
            ["api", "admin", "backup", ...(sub ? [sub] : [])]
          );
          return { status: res.status, data: (await res.json()) as any };
        };

        const st0 = await call("GET");
        assert.strictEqual(st0.data.configured, true);
        assert.strictEqual(st0.data.job.state, "failed", "previous (deliberately failed) run is shown");
        assert.ok(st0.data.job.error && st0.data.job.lastSuccess.file, "error + last success both exposed");
        const prevFile = st0.data.job.lastSuccess.file;

        await new Promise((r) => setTimeout(r, 1100)); // new timestamp -> new file name
        const run1 = await call("POST", "run");
        assert.strictEqual(run1.status, 202);
        const mid = await call("GET");
        assert.strictEqual(mid.data.job.running, true, "status is 'running' right after the 202");
        const run2 = await call("POST", "run");
        assert.strictEqual(run2.status, 409, "second start while running is rejected");

        let final = mid;
        for (let i = 0; i < 100 && final.data.job.running; i++) {
          await new Promise((r) => setTimeout(r, 200));
          final = await call("GET");
        }
        assert.strictEqual(final.data.job.state, "success", JSON.stringify(final.data.job));
        assert.notStrictEqual(final.data.job.lastSuccess.file, prevFile);

        const listed = await call("GET", "list");
        assert.strictEqual(listed.status, 200);
        assert.ok(listed.data.backups.some((b: any) => b.name === final.data.job.lastSuccess.file));

        const pre = await call("POST", "presign", { name: final.data.job.lastSuccess.file });
        assert.strictEqual(pre.status, 200);
        assert.strictEqual(new URL(pre.data.url).searchParams.get("X-Amz-Expires"), "300");
        assert.strictEqual((await call("POST", "presign", { name: "../../etc/passwd" })).status, 400);
        assert.strictEqual((await call("POST", "presign", {})).status, 400);

        // A job whose process died is reported as failed, not as running forever
        fs.writeFileSync(path.join(dataDir, ".backup_status.json"), JSON.stringify({ state: "running", pid: 2147483646, phase: "upload" }));
        const dead = await call("GET");
        assert.strictEqual(dead.data.job.state, "failed");
        assert.strictEqual(dead.data.job.running, false);
        console.log("✔ admin API: 202 background start, 409 while running, polling, list, presign, dead-process detection");
      } finally {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
      }
    }
  } finally {
    await mock.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log("\n>>> [TEST] Backup tests passed.");
}

runTests().catch((e) => { console.error(e); process.exit(1); });
