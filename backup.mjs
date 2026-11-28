#!/usr/bin/env node
/**
 * @file backup.mjs
 * @description ObexDNS backup job (replaces backup.sh).
 *
 * Pipeline: lock -> consistent snapshot (VACUUM INTO) -> integrity_check -> tar | zstd (paced)
 *           -> verify archive -> optional local copy -> upload to S3/R2 + refresh latest alias + prune.
 *
 * Why it is built this way:
 * - Correctness first: the snapshot is produced by SQLite in ONE read transaction (VACUUM INTO), so it is
 *   transactionally consistent even while the app commits and checkpoints. `.backup` is only a fallback for
 *   SQLite builds without VACUUM INTO. The live DB file is never copied byte-by-byte (that yields torn,
 *   corrupt copies under concurrent writes). The snapshot must pass integrity_check before it is packed.
 * - Every pipeline stage is checked (no shell pipes), the finished archive is tested, and the upload size is
 *   verified, before `latest` is allowed to point at a new backup.
 * - CPU: compression is paced (BACKUP_YIELD_CHUNK_KB / BACKUP_YIELD_SLEEP_MS) so it is spread out instead of
 *   one burst; zstd level defaults to 1; the process is niced to 19 and children inherit it.
 * - Progress/results go to <dataDir>/.backup_status.json so the admin UI can poll them; the job itself
 *   runs detached from the HTTP request.
 *
 * Usage: backup.mjs [--trigger cron|manual] [--no-upload]
 * Exit codes: 0 ok, 75 another backup is running, 1 failed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig, missingConfig, publishBackup } from './s3-client.mjs';

export const EXIT_BUSY = 75;
const STATUS_FILE = '.backup_status.json';
const LOCK_FILE = 'obexdns_backup.lock';

// ─── Pacing Stream ──────────────────────────────────────────────────────────

/**
 * Transform stream that yields between chunks to eliminate CPU spikes (>100%)
 * and keep the event loop free for uninterrupted DNS resolution.
 */
export class PacedTransform extends Transform {
  constructor(chunkBytes = 512 * 1024, sleepMs = 10) {
    super();
    this.chunkBytes = chunkBytes;
    this.sleepMs = sleepMs;
    this.remainder = null;
  }

  async _transform(chunk, encoding, callback) {
    let data = this.remainder ? Buffer.concat([this.remainder, chunk]) : chunk;
    this.remainder = null;

    let offset = 0;
    while (offset + this.chunkBytes <= data.length) {
      const slice = data.subarray(offset, offset + this.chunkBytes);
      offset += this.chunkBytes;
      this.push(slice);
      if (this.sleepMs > 0) {
        await new Promise((r) => setTimeout(r, this.sleepMs));
      }
    }

    if (offset < data.length) {
      this.remainder = data.subarray(offset);
    }
    callback();
  }

  _flush(callback) {
    if (this.remainder && this.remainder.length > 0) {
      this.push(this.remainder);
      this.remainder = null;
    }
    callback();
  }
}

// ─── Status file ─────────────────────────────────────────────────────────────

export function statusPath(dataDir) {
  return path.join(dataDir, STATUS_FILE);
}

export function readStatus(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(statusPath(dataDir), 'utf-8'));
  } catch {
    return null;
  }
}

function writeStatus(dataDir, status) {
  const file = statusPath(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(status));
    fs.renameSync(tmp, file); // atomic: the UI never reads a half-written file
  } catch {
    fs.rmSync(tmp, { force: true });
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

// ─── Lock ────────────────────────────────────────────────────────────────────

function acquireLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let holder = 0;
      try {
        holder = parseInt(fs.readFileSync(lockPath, 'utf-8'), 10);
      } catch {
        /* lock vanished: retry */
      }
      if (holder && pidAlive(holder)) return false;
      fs.rmSync(lockPath, { force: true }); // stale lock from a dead process
    }
  }
  return false;
}

// ─── Child processes ─────────────────────────────────────────────────────────

/** Runs a command, resolving { code, stdout, stderr }. Never throws on non-zero exit. */
function run(cmd, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Runs `producer | pacer | consumer`, writing consumer's stdout to outFile. Both stages must succeed. */
async function runPipe(producer, consumer, outFile, chunkBytes = 512 * 1024, sleepMs = 10) {
  const p = spawn(producer[0], producer.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
  const c = spawn(consumer[0], consumer.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
  let pErr = '';
  let cErr = '';
  p.stderr.on('data', (d) => (pErr += d));
  c.stderr.on('data', (d) => (cErr += d));

  const exits = [p, c].map(
    (proc) =>
      new Promise((resolve, reject) => {
        proc.on('error', reject);
        proc.on('close', (code) => resolve(code));
      })
  );
  const out = fs.createWriteStream(outFile);
  const pacer = new PacedTransform(chunkBytes, sleepMs);
  try {
    await Promise.all([pipeline(p.stdout, pacer, c.stdin), pipeline(c.stdout, out)]);
  } catch (err) {
    p.kill();
    c.kill();
    await Promise.allSettled(exits);
    // A broken pipe is a symptom; the failing stage's stderr is the cause.
    throw new Error(`${producer[0]} | ${consumer[0]} failed: ${(pErr || cErr).trim().slice(0, 300) || err.message}`);
  }
  const [pCode, cCode] = await Promise.all(exits);
  if (pCode !== 0) throw new Error(`${producer[0]} failed (exit ${pCode}): ${pErr.trim().slice(0, 300)}`);
  if (cCode !== 0) throw new Error(`${consumer[0]} failed (exit ${cCode}): ${cErr.trim().slice(0, 300)}`);
}

function hasBinary(cmd) {
  try {
    return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

const sqlQuote = (p) => `'${p.replace(/'/g, "''")}'`;

// ─── Steps ───────────────────────────────────────────────────────────────────

async function snapshotDatabase(dbFile, snapFile, log) {
  log(`[Backup] [1/4] Snapshotting SQLite database (${dbFile})...`);

  // Correctness rule: the snapshot is always produced BY SQLite inside one read transaction.
  // The live file is never copied byte-by-byte: while the app commits/checkpoints, a raw copy mixes pages
  // from different moments and yields a corrupt database that still looks valid at a glance.
  let r = await run('sqlite3', [dbFile, '.timeout 5000', `VACUUM INTO ${sqlQuote(snapFile)}`]);
  if (r.code !== 0) {
    log(`[Backup]       VACUUM INTO unavailable (${(r.stderr || r.stdout).trim().slice(0, 120)}); falling back to .backup`);
    fs.rmSync(snapFile, { force: true });
    r = await run('sqlite3', [dbFile, '.timeout 5000', `.backup main ${sqlQuote(snapFile)}`]);
    if (r.code !== 0) throw new Error(`SQLite snapshot failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  }
  if (!fs.existsSync(snapFile) || fs.statSync(snapFile).size === 0) throw new Error('SQLite snapshot is empty');

  // integrity_check (not quick_check): it also verifies that every index matches its table. It runs on the
  // private snapshot, so it never touches the live database.
  const check = await run('sqlite3', [snapFile, 'PRAGMA integrity_check;']);
  if (check.code !== 0 || check.stdout.trim() !== 'ok') {
    throw new Error(`Snapshot failed integrity_check: ${(check.stdout || check.stderr).trim().slice(0, 200)}`);
  }
  log(`[Backup]       -> snapshot OK (${(fs.statSync(snapFile).size / 1048576).toFixed(1)} MB, integrity_check ok).`);
}

async function createArchive(pkgDir, archive, codec, chunkBytes, sleepMs, log) {
  log(`[Backup] [2/4] Creating ${codec.name} archive (paced)...`);
  await runPipe(['tar', '-cf', '-', '-C', pkgDir, '.'], codec.compress, archive, chunkBytes, sleepMs);
  if (!fs.existsSync(archive) || fs.statSync(archive).size === 0) throw new Error('Archive is empty');
  log(`[Backup]       -> archive ${(fs.statSync(archive).size / 1048576).toFixed(1)} MB.`);
}

async function verifyArchive(archive, codec, log) {
  log('[Backup] [3/4] Verifying archive...');
  const t = await run(codec.test[0], [...codec.test.slice(1), archive]);
  if (t.code !== 0) throw new Error(`Archive integrity test failed: ${(t.stderr || t.stdout).trim().slice(0, 300)}`);

  // List contents. The decompressor may get SIGPIPE if tar stops at the end marker, so only tar's output matters.
  const dec = spawn(codec.decompress[0], [...codec.decompress.slice(1), archive], { stdio: ['ignore', 'pipe', 'ignore'] });
  const tar = spawn('tar', ['-tf', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
  dec.stdout.pipe(tar.stdin);
  tar.stdin.on('error', () => {});
  let listing = '';
  tar.stdout.on('data', (d) => (listing += d));
  const code = await new Promise((resolve, reject) => {
    tar.on('error', reject);
    tar.on('close', resolve);
  });
  dec.kill();
  if (code !== 0) throw new Error('Archive is not a readable tar');
  if (!/(^|\/)dns_worker\.sqlite$/m.test(listing)) throw new Error('Archive does not contain dns_worker.sqlite');
  log('[Backup]       -> archive verified.');
}

function pickCodec(level) {
  if (hasBinary('zstd')) {
    return {
      name: 'zstd',
      ext: 'tar.zst',
      compress: ['zstd', `-${level}`, '-T1', '-q', '-c'],
      test: ['zstd', '-t', '-q'],
      decompress: ['zstd', '-dc', '-q']
    };
  }
  return {
    name: 'gzip',
    ext: 'tar.gz',
    compress: ['gzip', '-1', '-c'],
    test: ['gzip', '-t'],
    decompress: ['gzip', '-dc']
  };
}

function pruneLocal(dir, keepDays, log) {
  const maxAge = keepDays * 86_400_000;
  for (const f of fs.readdirSync(dir)) {
    if (!/^obexdns_backup_\d{8}_\d{6}\.tar\.(zst|gz)$/.test(f)) continue;
    const p = path.join(dir, f);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > maxAge) {
        fs.rmSync(p);
        log(`[Backup]       -> removed expired local copy ${f}`);
      }
    } catch {
      /* ignore */
    }
  }
}

function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/**
 * Deletes every work directory this job ever created in tmpRoot (obexdns_backup_<random>).
 * Only call while holding the backup lock: then no other backup is running, so any such directory is
 * leftover from a run that was killed hard (SIGKILL / OOM) before its own cleanup could run.
 * Matches directories only, by the exact mkdtemp naming, so the lock file and unrelated files are untouched.
 */
export function removeWorkDirs(tmpRoot) {
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(tmpRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^obexdns_backup_[A-Za-z0-9]{4,16}$/.test(entry.name)) continue;
      try {
        fs.rmSync(path.join(tmpRoot, entry.name), { recursive: true, force: true });
        removed++;
      } catch {
        /* busy or no permission: leave it, try again next run */
      }
    }
  } catch {
    /* tmpRoot unreadable: nothing to clean */
  }
  return removed;
}

// ─── Main job ────────────────────────────────────────────────────────────────

/**
 * Runs one backup. Returns { ok, busy?, error?, file?, sizeBytes? }.
 * Paths/config are injectable for tests.
 */
export async function runBackup(opts = {}) {
  const log = opts.log || ((m) => console.log(m));
  const dataDir = opts.dataDir || process.env.OBEXDNS_DATA_DIR || '/data';
  const cfg = opts.cfg || loadConfig();
  const dbFile = opts.dbFile || cfg.dbPath || path.join(dataDir, 'dns_worker.sqlite');
  const tmpRoot = opts.tmpDir || os.tmpdir();
  const trigger = opts.trigger || 'cron';
  const upload = opts.upload !== false && missingConfig(cfg).length === 0;
  const keepLocal = Boolean(cfg.keepLocal);
  const localDest = cfg.localDest || path.join(dataDir, 'backups');
  const yieldChunkKb = opts.yieldChunkKb ?? cfg.yieldChunkKb;
  const yieldChunkBytes = yieldChunkKb * 1024;
  const yieldSleepMs = opts.yieldSleepMs ?? cfg.yieldSleepMs;

  const lockPath = path.join(tmpRoot, LOCK_FILE);
  if (!acquireLock(lockPath)) {
    log('[Backup] Another backup is already running. Skipping.');
    return { ok: false, busy: true };
  }

  const startedAt = Date.now();
  const previous = readStatus(dataDir);
  const lastSuccess = previous?.lastSuccess || null;
  const status = { state: 'running', trigger, phase: 'snapshot', pid: process.pid, startedAt, lastSuccess };
  const setPhase = (phase) => {
    status.phase = phase;
    writeStatus(dataDir, status);
  };
  writeStatus(dataDir, status);

  const leftovers = removeWorkDirs(tmpRoot);
  if (leftovers > 0) log(`[Backup] Removed ${leftovers} leftover work director${leftovers === 1 ? 'y' : 'ies'} from an interrupted run.`);

  const workDir = fs.mkdtempSync(path.join(tmpRoot, 'obexdns_backup_'));
  // Remove our own directory, then any other leftovers (we still hold the lock, so none can belong to a live run).
  const cleanup = () => {
    fs.rmSync(workDir, { recursive: true, force: true });
    removeWorkDirs(tmpRoot);
  };
  const onSignal = (sig) => {
    writeStatus(dataDir, { ...status, state: 'failed', error: `Interrupted (${sig})`, finishedAt: Date.now() });
    cleanup();
    fs.rmSync(lockPath, { force: true });
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  const sigHandlers = ['SIGINT', 'SIGTERM'].map((s) => {
    const h = () => onSignal(s);
    process.on(s, h);
    return [s, h];
  });

  try {
    try {
      os.setPriority(0, 19); // children inherit the nice level; DNS traffic keeps priority
    } catch {
      /* not supported / not permitted: continue at normal priority */
    }

    if (!upload && !keepLocal) {
      throw new Error('No backup destination: configure BACKUP_S3_* or BACKUP_KEEP_LOCAL=true');
    }
    if (!fs.existsSync(dbFile) || fs.statSync(dbFile).size === 0) throw new Error(`Database not found or empty: ${dbFile}`);

    const pkgDir = path.join(workDir, 'pkg');
    fs.mkdirSync(pkgDir);
    await snapshotDatabase(dbFile, path.join(pkgDir, 'dns_worker.sqlite'), log);

    const secret = path.join(dataDir, '.jwt_secret');
    if (fs.existsSync(secret)) fs.copyFileSync(secret, path.join(pkgDir, '.jwt_secret'));

    const codec = pickCodec(cfg.zstdLevel);
    const stamp = timestamp();
    const name = `obexdns_backup_${stamp}.${codec.ext}`;
    const archive = path.join(workDir, name);

    setPhase('archive');
    await createArchive(pkgDir, archive, codec, yieldChunkBytes, yieldSleepMs, log);
    fs.rmSync(pkgDir, { recursive: true, force: true }); // free disk before upload

    setPhase('verify');
    await verifyArchive(archive, codec, log);
    const sizeBytes = fs.statSync(archive).size;

    if (keepLocal) {
      fs.mkdirSync(localDest, { recursive: true });
      fs.copyFileSync(archive, path.join(localDest, name));
      log(`[Backup]       -> local copy saved to ${localDest}.`);
      pruneLocal(localDest, cfg.keepDays, log);
    }

    if (upload) {
      setPhase('upload');
      log('[Backup] [4/4] Uploading to S3/R2...');
      await publishBackup(cfg, archive, name, `latest.${codec.ext}`, cfg.keepDays, { onLog: log });
    } else {
      log('[Backup] [4/4] No S3 bucket configured; skipping upload.');
    }

    const finishedAt = Date.now();
    const done = { file: name, sizeBytes, finishedAt, uploaded: upload };
    writeStatus(dataDir, {
      state: 'success',
      trigger,
      pid: process.pid,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      ...done,
      lastSuccess: done
    });
    log(`[Backup] Completed in ${((finishedAt - startedAt) / 1000).toFixed(1)}s: ${name} (${(sizeBytes / 1048576).toFixed(1)} MB).`);
    return { ok: true, file: name, sizeBytes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[Backup] FAILED: ${message}`);
    writeStatus(dataDir, {
      state: 'failed',
      trigger,
      pid: process.pid,
      startedAt,
      finishedAt: Date.now(),
      phase: status.phase,
      error: message,
      lastSuccess
    });
    return { ok: false, error: message };
  } finally {
    for (const [s, h] of sigHandlers) process.off(s, h);
    cleanup();
    fs.rmSync(lockPath, { force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const t = argv.indexOf('--trigger');
  runBackup({
    trigger: t !== -1 && argv[t + 1] === 'manual' ? 'manual' : 'cron',
    upload: !argv.includes('--no-upload')
  }).then(
    (result) => process.exit(result.busy ? EXIT_BUSY : result.ok ? 0 : 1),
    (err) => {
      console.error('[Backup] Fatal error:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  );
}
