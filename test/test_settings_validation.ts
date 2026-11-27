/// <reference types="node" />
import assert from "node:assert";
import net from "node:net";
import { normalizeEcsSubnet, validateEcsSettings } from "../src/utils/ecsSubnet";
import { probeListUrl } from "../src/utils/listFetcher";
import { probeUpstream } from "../src/pipeline/resolver/probe";

const MB = 1024 * 1024;

// ── ECS ─────────────────────────────────────────────────────────────────────
function testEcs() {
  const ok = (raw: string, fam: 4 | 6, expected: string) => {
    const r = normalizeEcsSubnet(raw, fam);
    assert.ok(r.ok, `expected "${raw}" to be valid: ${JSON.stringify(r)}`);
    assert.strictEqual((r as { value: string }).value, expected);
  };
  const bad = (raw: string, fam: 4 | 6) => {
    const r = normalizeEcsSubnet(raw, fam);
    assert.ok(!r.ok, `expected "${raw}" (v${fam}) to be rejected`);
  };

  // A bare IP gets the default prefix appended.
  ok("1.2.3.4", 4, "1.2.3.4/24");
  ok("1.2.3.0/24", 4, "1.2.3.0/24");
  ok("1.2.3.0/16", 4, "1.2.3.0/16");
  ok("0.0.0.0/0", 4, "0.0.0.0/0");
  ok("2001:db8::", 6, "2001:db8::/48");
  ok("2001:DB8::/32", 6, "2001:db8::/32");

  // Garbage that used to be auto-saved.
  bad("1", 4);
  bad("", 4);
  bad("abc", 4);
  bad("1.2.3", 4);
  bad("1.2.3.4/33", 4);
  bad("1.2.3.4/abc", 4);
  bad("1.2.3.4/24/1", 4);
  bad("2001:db8::", 4); // wrong family
  bad("1.2.3.4", 6); // wrong family
  bad("2001:db8::/129", 6);
  bad("1", 6);

  // Whole block.
  const noSubnet = validateEcsSettings({ enabled: true, use_client_ip: false });
  assert.ok(!noSubnet.ok, "custom subnet enabled with no value must be rejected");

  const fromClient = validateEcsSettings({ enabled: true, use_client_ip: true });
  assert.ok(fromClient.ok);

  const v4only = validateEcsSettings({ enabled: true, use_client_ip: false, ipv4_cidr: "1.2.3.4" });
  assert.ok(v4only.ok);
  assert.strictEqual((v4only as any).value.ipv4_cidr, "1.2.3.4/24");
  assert.strictEqual((v4only as any).value.ipv6_cidr, undefined);

  const badV4 = validateEcsSettings({ enabled: true, use_client_ip: false, ipv4_cidr: "1" });
  assert.ok(!badV4.ok);

  // ECS disabled: no custom subnet required, stale empty values are fine.
  const disabled = validateEcsSettings({ enabled: false, use_client_ip: false });
  assert.ok(disabled.ok);
  console.log("  ✓ ECS subnet validation");
}

// ── List probe ──────────────────────────────────────────────────────────────
async function testListProbe() {
  const original = globalThis.fetch;
  const serve = (body: string, init: ResponseInit = {}) => {
    globalThis.fetch = (async () => new Response(body, init)) as any;
  };
  const URL_ = "http://93.184.216.34/list.txt";
  try {
    serve("0.0.0.0 ads.example.com\n0.0.0.0 tracker.example.net\n", { headers: { "content-type": "text/plain" } });
    let r = await probeListUrl(URL_, 25 * MB, 5000);
    assert.ok(r.ok, "hosts file must be accepted");

    serve("! Title: Test\n||ads.example.com^\n||track.example.org^$important\n@@||ok.example.com^\n");
    r = await probeListUrl(URL_, 25 * MB, 5000);
    assert.ok(r.ok, "AdGuard syntax must be accepted");
    assert.strictEqual((r as any).title, "Test");

    serve("ads.example.com\ntracker.example.net\n");
    r = await probeListUrl(URL_, 25 * MB, 5000);
    assert.ok(r.ok, "plain domain list must be accepted");

    // Not filter lists:
    serve("<!DOCTYPE html>\n<html><body>\n<h1>Hello</h1>\n</body></html>\n", { headers: { "content-type": "text/html" } });
    r = await probeListUrl(URL_, 25 * MB, 5000);
    assert.ok(!r.ok, "HTML page must be rejected");

    serve("<!DOCTYPE html>\nexample.com\n", { headers: { "content-type": "text/plain" } });
    r = await probeListUrl(URL_, 25 * MB, 5000);
    assert.ok(!r.ok, "HTML-looking body must be rejected even with a text/plain content-type");

    serve('{"error":"not a list"}\n');
    r = await probeListUrl(URL_, 25 * MB, 5000);
    assert.ok(!r.ok, "JSON document must be rejected");

    serve("! only comments\n# another comment\n\n");
    r = await probeListUrl(URL_, 25 * MB, 5000);
    assert.ok(!r.ok, "comment-only file (no rules) must be rejected");

    serve("");
    r = await probeListUrl(URL_, 25 * MB, 5000);
    assert.ok(!r.ok, "empty file must be rejected");

    serve("Not Found\nPage missing here\nsorry\n");
    r = await probeListUrl(URL_, 25 * MB, 5000);
    assert.ok(!r.ok, "prose text must be rejected");

    serve("nope", { status: 404, statusText: "Not Found" });
    r = await probeListUrl(URL_, 25 * MB, 5000);
    assert.ok(!r.ok && /404/.test(r.error), "HTTP errors must be rejected");

    // Early stop: a huge list is not downloaded in full.
    let pulled = 0;
    globalThis.fetch = (async () => {
      const chunk = new TextEncoder().encode(Array.from({ length: 2000 }, (_, i) => `||d${i}.example.com^\n`).join(""));
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          pulled++;
          if (pulled > 500) return c.close();
          c.enqueue(chunk);
        },
      });
      return new Response(stream);
    }) as any;
    r = await probeListUrl(URL_, 25 * MB, 5000);
    assert.ok(r.ok);
    assert.ok(pulled < 10, `probe must stop early (pulled ${pulled} chunks)`);
    console.log("  ✓ list probe");
  } finally {
    globalThis.fetch = original;
  }
}

// ── Upstream probe (against a local fake classic-DNS/TCP server) ─────────────
function startFakeDns(mode: "ok" | "refused" | "garbage" | "silent"): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        if (buf.length < 2) return;
        const len = buf.readUInt16BE(0);
        if (buf.length < 2 + len) return;
        const q = buf.subarray(2, 2 + len);
        if (mode === "silent") return;
        let resp: Buffer;
        if (mode === "garbage") {
          resp = Buffer.from("not dns at all, definitely");
        } else {
          resp = Buffer.from(q);
          resp[2] = 0x81; // QR=1, RD=1
          resp[3] = mode === "ok" ? 0x80 : 0x85; // RA / RCODE 5 (REFUSED)
          if (mode === "ok") {
            resp[7] = 0; // ANCOUNT stays 0, valid NOERROR response
          }
        }
        const framed = Buffer.alloc(2 + resp.length);
        framed.writeUInt16BE(resp.length, 0);
        resp.copy(framed, 2);
        sock.write(framed);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() });
    });
  });
}

async function testUpstreamProbe() {
  const ok = await startFakeDns("ok");
  const refused = await startFakeDns("refused");
  const garbage = await startFakeDns("garbage");
  try {
    let r = await probeUpstream(`tcp://127.0.0.1:${ok.port}`);
    assert.ok(r.ok, `working upstream must be accepted: ${JSON.stringify(r)}`);

    r = await probeUpstream(`tcp://127.0.0.1:${refused.port}`);
    assert.ok(!r.ok && /RCODE 5/.test(r.error), "REFUSED must be rejected");

    r = await probeUpstream(`tcp://127.0.0.1:${garbage.port}`);
    assert.ok(!r.ok, "non-DNS reply must be rejected");

    // Nothing listening.
    const dead = await startFakeDns("ok");
    dead.close();
    r = await probeUpstream(`tcp://127.0.0.1:${dead.port}`);
    assert.ok(!r.ok, "closed port must be rejected");
    console.log("  ✓ upstream probe");
  } finally {
    ok.close();
    refused.close();
    garbage.close();
  }
}

async function main() {
  console.log("settings validation");
  testEcs();
  await testListProbe();
  await testUpstreamProbe();
  console.log("OK");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
