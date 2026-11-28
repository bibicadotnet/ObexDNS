/**
 * @file test_guard.ts
 * @description Connection guard: range merge / binary search, base64, geo fail-open, token buckets, penalty,
 * allowlist/private bypass, sync safety (keep old list), isSyncing, eviction, units (ms in RAM / seconds in DB), dry-run, heap.
 */
import assert from 'node:assert';
import {
  cidrToRange, decodeRanges, encodeRanges, inRanges, ipToUint32, isPrivateUint32, mergeRanges, parseRangeLines
} from '../src/serverfull/guard/ip';
import { getOrCreateEntry, refill, cleanupEntries, state } from '../src/serverfull/guard/store';
import {
  ALLOWLIST_KEY, ALLOWLIST_URLS_KEY, buildSourceUrl, geoKey, geoSourcesKey, geoUpdatedKey, isSyncRunning, runSync, sourcesSignature
} from '../src/serverfull/guard/sync';
import {
  attachGuard, checkRequestHit, getNextSyncAt, guardTick, initGuard, onConnection, readGuardConfig, resetGuardForTests
} from '../src/serverfull/guard';
import { SystemSettingsModel } from '../src/models/systemSettings';

// ── helpers ──────────────────────────────────────────────────────────────────
const num = (s: string): number => ipToUint32(s)!;
const dotted = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

class FakeD1 {
  store = new Map<string, string>();
  prepare(sql: string) {
    return {
      bind: (...args: any[]) => ({
        sql, args,
        first: async () => {
          if (/^SELECT value/i.test(sql)) { const v = this.store.get(args[0]); return v === undefined ? null : { value: v }; }
          return null;
        },
        run: async () => {
          if (/^INSERT/i.test(sql)) this.store.set(args[0], args[1]);
          return { success: true };
        }
      }),
      run: async () => ({ success: true })
    };
  }
  async batch(stmts: any[]) { for (const s of stmts) await s.run(); return []; }
}

const BASE_ENV = { ALLOWLIST_IPS: '', ALLOWLIST_URLS: '' };
function mkEnv(db: FakeD1, extra: Record<string, string> = {}): any {
  return { DB: db, ...BASE_ENV, ...extra };
}
/** n separate (non adjacent) /24 ranges starting at 30.0.0.0 */
function ranges24(n: number, base = num('30.0.0.0')): Array<[number, number]> {
  return Array.from({ length: n }, (_, i) => [base + i * 512, base + i * 512 + 255] as [number, number]);
}
function toText(pairs: Array<[number, number]>): string {
  return pairs.map(([s]) => `${dotted(s)}/24`).join('\n');
}
function prefill(db: FakeD1, cc: string, pairs: Array<[number, number]>, updatedAtSec: number | null): void {
  db.store.set(geoKey(cc), encodeRanges(mergeRanges(pairs)));
  if (updatedAtSec !== null) db.store.set(geoUpdatedKey(cc), String(updatedAtSec));
  db.store.set(geoSourcesKey(cc), sourcesSignature(readGuardConfig({}).geoSources)); // built from the current default sources
}
const fakeSocket = (ip: string) => {
  const s = { remoteAddress: ip, destroyed: 0, destroy() { s.destroyed++; } };
  return s;
};

const realNow = Date.now;
const realFetch = globalThis.fetch;
const realLog = console.log;
const realWarn = console.warn;
let clock: number | null = null;
Date.now = () => (clock !== null ? clock : realNow());
const quiet = () => { console.log = () => {}; console.warn = () => {}; };
const loud = () => { console.log = realLog; console.warn = realWarn; };

async function waitSyncIdle(): Promise<void> {
  for (let i = 0; i < 200 && isSyncRunning(); i++) await new Promise((r) => setTimeout(r, 5));
}
function mockFetch(handler: (url: string) => { status?: number; body?: string } | Promise<{ status?: number; body?: string }> | 'fail'): { calls: string[] } {
  const calls: string[] = [];
  (globalThis as any).fetch = async (url: string) => {
    calls.push(String(url));
    const r = await handler(String(url));
    if (r === 'fail') throw new Error('network down');
    return new Response(r.body ?? '', { status: r.status ?? 200 });
  };
  return { calls };
}
async function fresh(db: FakeD1, extra: Record<string, string> = {}): Promise<any> {
  SystemSettingsModel.clearMemoryCache();
  resetGuardForTests();
  const env = mkEnv(db, extra);
  quiet();
  await initGuard(env);
  await waitSyncIdle();
  return env;
}

async function main(): Promise<void> {
  quiet();
  // ── 1. merge + binary search at the edges ─────────────────────────────────
  {
    const m = mergeRanges([[10, 20], [15, 30], [31, 40], [50, 60], [0, 0]]);
    assert.deepStrictEqual(Array.from(m), [0, 0, 10, 40, 50, 60], 'overlap + adjacent merge, sorted');
    for (const [ip, exp] of [[0, true], [1, false], [9, false], [10, true], [40, true], [41, false], [49, false], [50, true], [60, true], [61, false]] as const) {
      assert.strictEqual(inRanges(m, ip), exp, `ip ${ip}`);
    }
    assert.strictEqual(inRanges(new Uint32Array(0), 5), false);
    assert.strictEqual(inRanges(null, 5), false);
    // top of the address space: no overflow when merging adjacent
    const top = mergeRanges([[0xfffffffe, 0xfffffffe], [0xffffffff, 0xffffffff]]);
    assert.deepStrictEqual(Array.from(top), [0xfffffffe, 0xffffffff]);
    assert.ok(inRanges(top, 0xffffffff) && !inRanges(top, 0xfffffffd));
    // CIDR -> range, single IP -> /32, junk dropped, IPv6 dropped
    assert.deepStrictEqual(cidrToRange('1.2.3.0/24'), [num('1.2.3.0'), num('1.2.3.255')]);
    assert.deepStrictEqual(cidrToRange('1.2.3.4'), [num('1.2.3.4'), num('1.2.3.4')]);
    assert.deepStrictEqual(cidrToRange('0.0.0.0/0'), [0, 0xffffffff]);
    assert.strictEqual(cidrToRange('2001:db8::/32'), null);
    assert.strictEqual(cidrToRange('999.1.1.1'), null);
    const parsed = parseRangeLines('# comment\n\n1.1.1.1\n2.2.2.0/24 extra\r\nbad\n2001:db8::/32\n');
    assert.strictEqual(parsed.length, 2);
    // private ranges on uint32
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.5.5']) assert.ok(isPrivateUint32(num(ip)), ip);
    for (const ip of ['172.15.255.255', '172.32.0.0', '192.169.0.1', '8.8.8.8', '11.0.0.1']) assert.ok(!isPrivateUint32(num(ip)), ip);
    assert.strictEqual(ipToUint32('::ffff:1.2.3.4'), num('1.2.3.4'));
    assert.strictEqual(ipToUint32('2001:db8::1'), null);
    assert.strictEqual(buildSourceUrl('x/{cc}/{CC}.txt', 'VN'), 'x/vn/VN.txt');
  }

  // ── 2. base64 round trip ──────────────────────────────────────────────────
  {
    const arr = mergeRanges(ranges24(5000));
    const back = decodeRanges(encodeRanges(arr))!;
    assert.deepStrictEqual(Array.from(back), Array.from(arr));
    assert.strictEqual(decodeRanges(encodeRanges(new Uint32Array(0)))!.length, 0);
    assert.strictEqual(decodeRanges('!!!not base64'), null);
    assert.strictEqual(decodeRanges(btoa('abcd')), null, 'length not multiple of 8');
    assert.strictEqual(decodeRanges(encodeRanges(Uint32Array.from([5, 1]))), null, 'start > end');
    assert.strictEqual(decodeRanges(encodeRanges(Uint32Array.from([1, 5, 3, 9]))), null, 'overlap');
    assert.strictEqual(decodeRanges(null), null);
  }

  // ── 3. both switches off: nothing runs ────────────────────────────────────
  {
    resetGuardForTests();
    await initGuard(mkEnv(new FakeD1()));
    assert.strictEqual(state.active, false);
    let attached = 0;
    attachGuard({ prependListener: () => { attached++; } });
    assert.strictEqual(attached, 0, 'no listener when both switches are off');
    for (let i = 0; i < 100; i++) assert.ok(checkRequestHit('8.8.8.8'));
    assert.strictEqual(state.map.size, 0);
    await guardTick(mkEnv(new FakeD1())); // must be a no-op
  }

  // ── 4. geo fail-open when one country is missing, effective when all exist ─
  {
    mockFetch(() => 'fail');
    const db = new FakeD1();
    prefill(db, 'VN', [[num('1.0.0.0'), num('1.0.0.255')]], Math.floor(realNow() / 1000));
    await fresh(db, { ENABLE_ALLOW_COUNTRIES: 'true', ALLOW_COUNTRIES: 'VN,SG', GUARD_MIN_RANGES: '1' });
    assert.strictEqual(state.geoActive, false, 'SG missing -> geo inactive');
    const s1 = fakeSocket('9.9.9.9');
    onConnection(s1);
    assert.strictEqual(s1.destroyed, 0, 'fail-open');

    const db2 = new FakeD1();
    prefill(db2, 'VN', [[num('1.0.0.0'), num('1.0.0.255')]], Math.floor(realNow() / 1000));
    prefill(db2, 'SG', [[num('2.0.0.0'), num('2.0.0.255')]], Math.floor(realNow() / 1000));
    await fresh(db2, { ENABLE_ALLOW_COUNTRIES: 'true', ALLOW_COUNTRIES: 'VN,SG' });
    assert.strictEqual(state.geoActive, true);
    const inVn = fakeSocket('1.0.0.77'); const inSg = fakeSocket('2.0.0.1'); const out = fakeSocket('9.9.9.9');
    const priv = fakeSocket('192.168.1.1');
    [inVn, inSg, out, priv].forEach(onConnection);
    assert.deepStrictEqual([inVn.destroyed, inSg.destroyed, out.destroyed, priv.destroyed], [0, 0, 1, 0]);
    assert.strictEqual(state.map.size, 0, 'geo is checked before an entry is created');

    // empty ALLOW_COUNTRIES (invalid codes only) must not block everybody
    const db3 = new FakeD1();
    const warns: string[] = [];
    console.warn = (...a: any[]) => { warns.push(a.join(' ')); };
    readGuardConfig({ ENABLE_ALLOW_COUNTRIES: 'true', ALLOW_COUNTRIES: 'xyz,1' });
    quiet();
    await fresh(db3, { ENABLE_ALLOW_COUNTRIES: 'true', ALLOW_COUNTRIES: 'xyz,1' });
    assert.ok(warns.some((w) => /ignoring invalid country code\(s\): XYZ, 1/.test(w)), warns.join('|'));
    assert.ok(warns.some((w) => /Falling back to the default: VN,SG,JP,HK/.test(w)), warns.join('|'));
    assert.deepStrictEqual(state.cfg!.countries, ['VN', 'SG', 'JP', 'HK'], 'invalid codes fall back to the default list');
    assert.strictEqual(state.geoActive, false, 'fail-open: nothing downloaded yet');
  }

  // ── 5. token refill is smooth in milliseconds ─────────────────────────────
  {
    assert.strictEqual(refill(0, 0, 250, 10, 10), 2.5);
    assert.strictEqual(refill(0, 0, 100000, 10, 10), 10, 'capped by burst');
    assert.strictEqual(refill(3, 1000, 500, 10, 10), 3, 'negative elapsed counts as 0');

    const db = new FakeD1();
    await fresh(db, { ENABLE_RATE_LIMIT: 'true', RATE_LIMIT_TCP: '10', BURST_TCP: '10', PENALTY_TIME: '5' });
    clock = 1_000_000;
    const ip = '8.8.4.4';
    for (let i = 0; i < 10; i++) { const s = fakeSocket(ip); onConnection(s); assert.strictEqual(s.destroyed, 0); }
    clock += 100; // +1 token
    const ok = fakeSocket(ip); onConnection(ok);
    assert.strictEqual(ok.destroyed, 0, 'one token came back after 100 ms');
    const e = state.map.get(num(ip))!;
    assert.ok(e.tokConn < 0.01, 'all tokens spent');
    assert.strictEqual(e.penaltyUntil, 0, 'no penalty while tokens last');
    clock += 50; // only 0.5 token
    const no = fakeSocket(ip); onConnection(no);
    assert.strictEqual(no.destroyed, 1, 'half a token is not enough');
    clock = null;
  }

  // ── 6. two independent buckets ────────────────────────────────────────────
  {
    const db = new FakeD1();
    await fresh(db, { ENABLE_RATE_LIMIT: 'true', BURST_TCP: '100', BURST_REQ: '50', RATE_LIMIT_TCP: '1', RATE_LIMIT_REQ: '1' });
    clock = 5_000_000;
    const ip = '8.8.4.4';
    for (let i = 0; i < 20; i++) assert.ok(checkRequestHit(ip));
    let e = state.map.get(num(ip))!;
    assert.strictEqual(Math.round(e.tokReq), 30);
    assert.strictEqual(e.tokConn, 100, 'requests do not touch the connection bucket');
    for (let i = 0; i < 30; i++) onConnection(fakeSocket(ip));
    e = state.map.get(num(ip))!;
    assert.strictEqual(Math.round(e.tokConn), 70);
    assert.strictEqual(Math.round(e.tokReq), 30, 'connections do not touch the request bucket');
    clock = null;
  }

  // ── 7. allowlist / private are never counted ──────────────────────────────
  {
    const db = new FakeD1();
    await fresh(db, { ENABLE_RATE_LIMIT: 'true', BURST_TCP: '1', BURST_REQ: '1', ALLOWLIST_IPS: '203.0.113.0/24,198.51.100.7' });
    for (let i = 0; i < 5000; i++) {
      for (const ip of ['203.0.113.50', '198.51.100.7', '10.0.0.1', '127.0.0.1', '172.20.1.1', '192.168.0.9']) {
        const s = fakeSocket(ip); onConnection(s);
        assert.strictEqual(s.destroyed, 0);
        assert.ok(checkRequestHit(ip));
      }
    }
    assert.strictEqual(state.map.size, 0, 'no entry created for allowlist / private');
    // a URL-sourced allowlist is merged with the env one
    state.urlAllow = mergeRanges([[num('45.0.0.0'), num('45.0.0.255')]]);
    state.allow = mergeRanges([[num('203.0.113.0'), num('203.0.113.255')], [num('45.0.0.0'), num('45.0.0.255')]]);
    assert.ok(checkRequestHit('45.0.0.9') && checkRequestHit('45.0.0.9'));
    assert.strictEqual(state.map.size, 0);
  }

  // ── 8. penalty: 100% destroyed while penalised, extended while spamming ───
  {
    const db = new FakeD1();
    await fresh(db, { ENABLE_RATE_LIMIT: 'true', BURST_TCP: '1', RATE_LIMIT_TCP: '1', BURST_REQ: '1', RATE_LIMIT_REQ: '1', PENALTY_TIME: '5' });
    clock = 10_000_000;
    const ip = '8.8.4.4';
    const first = fakeSocket(ip); onConnection(first);
    assert.strictEqual(first.destroyed, 0);
    const trip = fakeSocket(ip); onConnection(trip);
    assert.strictEqual(trip.destroyed, 1, 'out of tokens -> destroy');
    const e = state.map.get(num(ip))!;
    assert.strictEqual(e.penaltyUntil, clock + 5000);
    for (let i = 0; i < 100; i++) {
      clock += 40; // 4 s in total, tokens would have refilled but the penalty wins
      const s = fakeSocket(ip); onConnection(s);
      assert.strictEqual(s.destroyed, 1);
    }
    assert.strictEqual(e.penaltyUntil, clock + 5000, 'penalty extended by every attempt');
    assert.strictEqual(checkRequestHit(ip), false, 'request path honours the same penalty');
    clock += 4000;
    assert.strictEqual(checkRequestHit(ip), false, 'still inside the extended penalty');
    clock += 6000; // quiet for longer than PENALTY_TIME
    const later = fakeSocket(ip); onConnection(later);
    assert.strictEqual(later.destroyed, 0, 'penalty over, bucket refilled');
    clock = null;
  }

  // ── 9. request bucket exhaustion ──────────────────────────────────────────
  {
    const db = new FakeD1();
    await fresh(db, { ENABLE_RATE_LIMIT: 'true', BURST_REQ: '5', RATE_LIMIT_REQ: '1', PENALTY_TIME: '5' });
    clock = 20_000_000;
    const res = Array.from({ length: 7 }, () => checkRequestHit('8.8.4.4'));
    assert.deepStrictEqual(res, [true, true, true, true, true, false, false]);
    // only the geo switch on: requests are never counted
    await fresh(db, { ENABLE_ALLOW_COUNTRIES: 'true' });
    for (let i = 0; i < 100; i++) assert.ok(checkRequestHit('8.8.4.4'));
    assert.strictEqual(state.map.size, 0);
    clock = null;
  }

  // ── 10. eviction never pushes out a penalised entry ───────────────────────
  {
    const db = new FakeD1();
    await fresh(db, { ENABLE_RATE_LIMIT: 'true', GUARD_MAX_ENTRIES: '1000' });
    const now = 30_000_000;
    clock = now;
    for (let i = 0; i < 1000; i++) getOrCreateEntry(1_000_000 + i, now);
    assert.strictEqual(state.map.size, 1000);
    for (let i = 0; i < 16; i++) state.map.get(1_000_000 + i)!.penaltyUntil = now + 60_000;
    getOrCreateEntry(5_000_000, now);
    assert.strictEqual(state.map.size, 1000, 'hard cap holds');
    for (let i = 0; i < 16; i++) assert.ok(state.map.has(1_000_000 + i), `penalised ${i} kept`);
    assert.ok(!state.map.has(1_000_016), 'first non-penalised entry evicted');
    assert.ok(state.map.has(5_000_000));

    // every entry penalised: the first key is still dropped so the cap holds
    for (const e of state.map.values()) e.penaltyUntil = now + 60_000;
    const keysBefore = new Set(state.map.keys());
    getOrCreateEntry(6_000_000, now);
    assert.strictEqual(state.map.size, 1000);
    assert.ok(state.map.has(6_000_000));
    const gone = [...keysBefore].filter((k) => !state.map.has(k));
    assert.strictEqual(gone.length, 1, 'exactly one entry dropped after 16 rotations');

    // idle cleanup keeps penalised entries
    clock = now + 301_000;
    for (const [k, e] of state.map) if (k !== 6_000_000) e.penaltyUntil = k % 2 ? now + 400_000 : 0;
    const removed = cleanupEntries(clock);
    assert.ok(removed > 0);
    for (const [k, e] of state.map) assert.ok(e.penaltyUntil > clock || k === 6_000_000 || e.lastSeen >= clock - 300_000);
    clock = null;
  }

  // ── 11. sync safety: keep the old list ────────────────────────────────────
  {
    const nowSec = Math.floor(realNow() / 1000);
    const db = new FakeD1();
    prefill(db, 'VN', ranges24(1000), nowSec - 100);
    const env = await fresh(db, { ENABLE_ALLOW_COUNTRIES: 'true', ALLOW_COUNTRIES: 'VN' });
    assert.strictEqual(state.geoActive, true);
    const oldArr = state.geo.get('VN')!;
    const oldDb = db.store.get(geoKey('VN'));
    const url = (t: string) => buildSourceUrl(t, 'VN');
    void url;

    // a) every source fails
    let m = mockFetch(() => 'fail');
    await runSync(env);
    assert.strictEqual(m.calls.length, 4, 'four sources tried');
    assert.strictEqual(state.geo.get('VN'), oldArr);
    assert.strictEqual(db.store.get(geoKey('VN')), oldDb);
    let delta = getNextSyncAt() - realNow();
    assert.ok(delta > 29 * 60_000 && delta <= 30 * 60_000, `retry in 30 min, got ${delta}`);

    // b) fewer than GUARD_MIN_RANGES (100)
    mockFetch(() => ({ body: toText(ranges24(50, num('60.0.0.0'))) }));
    await runSync(env);
    assert.strictEqual(state.geo.get('VN'), oldArr, 'below GUARD_MIN_RANGES');

    // c) above the minimum but below 50 % of the current 1000 ranges
    mockFetch(() => ({ body: toText(ranges24(400, num('60.0.0.0'))) }));
    await runSync(env);
    assert.strictEqual(state.geo.get('VN'), oldArr, 'below GUARD_MIN_RANGES_RATIO');
    assert.strictEqual(db.store.get(geoKey('VN')), oldDb);

    // !res.ok and comments / junk lines are ignored
    mockFetch((u) => u.includes('ipdeny') ? { status: 500, body: 'x' } : { body: '# c\n\njunk\n' + toText(ranges24(600, num('70.0.0.0'))) });
    await runSync(env);
    const accepted = state.geo.get('VN')!;
    assert.notStrictEqual(accepted, oldArr, 'accepted: 600 >= 100 and >= 50 % of 1000');
    assert.strictEqual(accepted.length / 2, 600, 'duplicates from the 3 good sources merged');
    const delta2 = getNextSyncAt() - realNow();
    assert.ok(delta2 > 23.9 * 3600_000 && delta2 <= 24 * 3600_000, 'next sync in 24 h');

    // d) updated_at is written in SECONDS
    const written = Number(db.store.get(geoUpdatedKey('VN')));
    assert.ok(Math.abs(written - Math.floor(realNow() / 1000)) <= 5, `seconds, got ${written}`);
    assert.ok(written < 1e11);
    assert.deepStrictEqual(Array.from(decodeRanges(db.store.get(geoKey('VN')))!), Array.from(accepted));

    // e) one country fails, the other still updates (independent)
    const db2 = new FakeD1();
    prefill(db2, 'VN', ranges24(300), nowSec - 100);
    prefill(db2, 'SG', ranges24(300, num('80.0.0.0')), nowSec - 100);
    const env2 = await fresh(db2, { ENABLE_ALLOW_COUNTRIES: 'true', ALLOW_COUNTRIES: 'VN,SG' });
    const vnOld = state.geo.get('VN')!;
    mockFetch((u) => /\/vn[./]|VN-/i.test(u) ? 'fail' : { body: toText(ranges24(320, num('90.0.0.0'))) });
    await runSync(env2);
    assert.strictEqual(state.geo.get('VN'), vnOld, 'failed country keeps its old list');
    assert.strictEqual(state.geo.get('SG')!.length / 2, 320, 'other country updated');
    const d3 = getNextSyncAt() - realNow();
    assert.ok(d3 <= 30 * 60_000, 'any failed item -> retry delay');
    assert.ok(state.geoActive);
  }

  // ── 12. allowlist sync: needs >= 1 range, keeps old otherwise ─────────────
  {
    const db = new FakeD1();
    const env = await fresh(db, { ENABLE_RATE_LIMIT: 'true', ALLOWLIST_URLS: 'https://a.example/list.txt,https://b.example/list.txt', ALLOWLIST_IPS: '203.0.113.1' });
    mockFetch((u) => u.startsWith('https://a') ? { body: '# monitors\n45.1.1.1\n45.1.2.0/24\n' } : 'fail');
    await runSync(env);
    assert.ok(checkRequestHit('45.1.1.1'));
    assert.strictEqual(state.map.size, 0, 'URL allowlist applies');
    assert.ok(db.store.has('guard:allowlist'));
    assert.ok(Number(db.store.get('guard:allowlist:updated_at')) < 1e11);
    const before = state.urlAllow;
    mockFetch(() => ({ body: '# nothing\n' }));
    await runSync(env);
    assert.strictEqual(state.urlAllow, before, 'empty download keeps the old allowlist');
    assert.ok(state.allow.length >= 2 && inRanges(state.allow, num('203.0.113.1')), 'env allowlist always merged');
  }

  // ── 13. isSyncing prevents overlapping runs ───────────────────────────────
  {
    const db = new FakeD1();
    const env = await fresh(db, { ENABLE_ALLOW_COUNTRIES: 'true', ALLOW_COUNTRIES: 'VN' });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const m = mockFetch(async () => { await gate; return { body: toText(ranges24(200)) }; });
    const p1 = runSync(env);
    assert.ok(isSyncRunning());
    await runSync(env); // returns at once
    assert.strictEqual(m.calls.length, 4, 'second call did not start new downloads');
    release();
    await p1;
    assert.ok(!isSyncRunning());
    assert.strictEqual(m.calls.length, 4);
  }

  // ── 14. nextSyncAt units (DB seconds -> RAM ms) ───────────────────────────
  {
    const nowSec = Math.floor(realNow() / 1000);
    mockFetch(() => 'fail');
    const run = async (ageSec: number | null) => {
      const db = new FakeD1();
      prefill(db, 'VN', ranges24(10), ageSec === null ? null : nowSec - ageSec);
      await fresh(db, { ENABLE_ALLOW_COUNTRIES: 'true', ALLOW_COUNTRIES: 'VN' });
      return getNextSyncAt();
    };
    assert.ok(await run(3600) > realNow(), '1 h old -> not due');
    assert.ok(await run(25 * 3600) < realNow(), '25 h old -> due');
    assert.strictEqual(await run(null), 0, 'missing updated_at -> 0');
    const approx = (await run(3600)) - realNow();
    assert.ok(approx > 22.9 * 3600_000 && approx < 23.1 * 3600_000, `~23 h left, got ${approx}`);
  }

  // ── 15. guardTick: only syncs when due ────────────────────────────────────
  {
    const db = new FakeD1();
    const env = await fresh(db, { ENABLE_ALLOW_COUNTRIES: 'true', ALLOW_COUNTRIES: 'VN' });
    state.nextSyncAt = realNow() + 60_000;
    let m = mockFetch(() => ({ body: toText(ranges24(150)) }));
    await guardTick(env);
    assert.strictEqual(m.calls.length, 0, 'not due');
    state.nextSyncAt = realNow() - 1;
    await guardTick(env);
    assert.strictEqual(m.calls.length, 4, 'due -> sync');
    assert.strictEqual(state.geoActive, true);
  }

  // ── 16. dry-run: log only, nothing closed, no penalty ─────────────────────
  {
    const db = new FakeD1();
    prefill(db, 'VN', [[num('1.0.0.0'), num('1.0.0.255')]], Math.floor(realNow() / 1000));
    const logs: string[] = [];
    await fresh(db, { ENABLE_ALLOW_COUNTRIES: 'true', ALLOW_COUNTRIES: 'VN', ENABLE_RATE_LIMIT: 'true', GUARD_DRY_RUN: 'true', BURST_TCP: '2', BURST_REQ: '2', RATE_LIMIT_TCP: '1', RATE_LIMIT_REQ: '1' });
    console.log = (...a: any[]) => { logs.push(a.join(' ')); };
    clock = 40_000_000;
    const geoSock = fakeSocket('9.9.9.9'); onConnection(geoSock);
    assert.strictEqual(geoSock.destroyed, 0);
    const socks = Array.from({ length: 6 }, () => fakeSocket('1.0.0.5'));
    socks.forEach(onConnection);
    assert.ok(socks.every((s) => s.destroyed === 0), 'never destroyed in dry-run');
    for (let i = 0; i < 6; i++) assert.ok(checkRequestHit('1.0.0.5'));
    assert.strictEqual(state.map.get(num('1.0.0.5'))!.penaltyUntil, 0, 'penalty state untouched');
    assert.ok(logs.some((l) => /would block 9\.9\.9\.9 geo/.test(l)), logs.join('|'));
    assert.ok(logs.some((l) => /would block 1\.0\.0\.5 rate-tcp/.test(l)));
    assert.ok(logs.some((l) => /would block 1\.0\.0\.5 rate-req/.test(l)));
    clock = null;
    quiet();
  }

  // ── 17. hooks attach to a server only when active ─────────────────────────
  {
    const db = new FakeD1();
    await fresh(db, { ENABLE_RATE_LIMIT: 'true' });
    const events: string[] = [];
    attachGuard({ prependListener: (ev: string, fn: unknown) => { events.push(ev); assert.strictEqual(typeof fn, 'function'); } });
    assert.deepStrictEqual(events, ['connection']);
  }

  // ── 18. heap with GUARD_MAX_ENTRIES entries ───────────────────────────────
  {
    const db = new FakeD1();
    await fresh(db, { ENABLE_RATE_LIMIT: 'true' });
    const gc = (globalThis as any).gc as (() => void) | undefined;
    gc?.();
    const before = process.memoryUsage().heapUsed;
    const t0 = realNow();
    for (let i = 0; i < 100_000; i++) getOrCreateEntry(0x08000000 + i, t0);
    gc?.();
    const usedMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
    assert.strictEqual(state.map.size, 100_000);
    getOrCreateEntry(0x7f000000, t0);
    assert.strictEqual(state.map.size, 100_000, 'hard cap');
    loud();
    console.log(`  heap for 100000 entries: ~${usedMb.toFixed(1)} MB${gc ? '' : ' (no --expose-gc, approximate)'}`);
    assert.ok(usedMb < 80, `too much memory: ${usedMb} MB`);
  }

  // ── 19. changed sources are picked up at boot, not after 24 h ─────────────
  {
    const nowSec = Math.floor(realNow() / 1000);
    // a) GUARD_GEO_SOURCES edited: fresh data (updated 1 min ago) is refreshed right away, ratio check does not apply
    const db = new FakeD1();
    prefill(db, 'VN', ranges24(1000), nowSec - 60);
    db.store.set(geoSourcesKey('VN'), sourcesSignature(['https://old.example/{cc}.txt']));
    const m = mockFetch(() => ({ body: toText(ranges24(400, num('60.0.0.0'))) })); // 400 < 50 % of 1000
    await fresh(db, { ENABLE_ALLOW_COUNTRIES: 'true', ALLOW_COUNTRIES: 'VN' });
    assert.strictEqual(m.calls.length, 4, 'background sync started by the changed sources');
    assert.strictEqual(state.geo.get('VN')!.length / 2, 400, 'new list accepted despite the ratio');
    assert.strictEqual(db.store.get(geoSourcesKey('VN')), sourcesSignature(readGuardConfig({}).geoSources), 'signature saved with the list');
    assert.ok(getNextSyncAt() - realNow() > 23 * 3600_000);
    // next boot: same sources -> nothing to do, and the ratio protection is back
    const m2 = mockFetch(() => ({ body: toText(ranges24(400, num('60.0.0.0'))) }));
    await fresh(db, { ENABLE_ALLOW_COUNTRIES: 'true', ALLOW_COUNTRIES: 'VN' });
    assert.strictEqual(m2.calls.length, 0, 'unchanged sources: no sync');
    assert.ok(getNextSyncAt() > realNow());
    assert.strictEqual(state.sourcesChanged.size, 0);

    // b) order / whitespace of the sources does not count as a change
    const reordered = readGuardConfig({}).geoSources.slice().reverse().map((u) => ` ${u} `).join(',');
    const m3 = mockFetch(() => ({ body: toText(ranges24(400, num('60.0.0.0'))) }));
    await fresh(db, { ENABLE_ALLOW_COUNTRIES: 'true', ALLOW_COUNTRIES: 'VN', GUARD_GEO_SOURCES: reordered });
    assert.strictEqual(m3.calls.length, 0);

    // c) failed sync after a change: old list stays, signature NOT updated, so the next boot tries again
    const db2 = new FakeD1();
    prefill(db2, 'VN', ranges24(300), nowSec - 60);
    db2.store.set(geoSourcesKey('VN'), 'old');
    const oldSig = 'old';
    mockFetch(() => 'fail');
    await fresh(db2, { ENABLE_ALLOW_COUNTRIES: 'true', ALLOW_COUNTRIES: 'VN' });
    assert.strictEqual(state.geo.get('VN')!.length / 2, 300, 'old list still in use');
    assert.strictEqual(db2.store.get(geoSourcesKey('VN')), oldSig);
    assert.ok(state.sourcesChanged.has('VN'));
    assert.ok(getNextSyncAt() - realNow() <= 30 * 60_000, 'retry soon');
    assert.ok(state.geoActive, 'connections keep being filtered with the old list meanwhile');

    // d) ALLOWLIST_URLS edited: re-downloaded at boot
    const db3 = new FakeD1();
    db3.store.set(ALLOWLIST_KEY, encodeRanges(mergeRanges([[num('45.0.0.0'), num('45.0.0.255')]])));
    db3.store.set('guard:allowlist:updated_at', String(nowSec - 60));
    db3.store.set(ALLOWLIST_URLS_KEY, sourcesSignature(['https://old.example/list.txt']));
    mockFetch(() => ({ body: '46.0.0.1\n' }));
    await fresh(db3, { ENABLE_RATE_LIMIT: 'true', ALLOWLIST_URLS: 'https://new.example/list.txt' });
    assert.ok(inRanges(state.allow, num('46.0.0.1')) && !inRanges(state.allow, num('45.0.0.5')), 'list replaced by the new URL');
    assert.strictEqual(db3.store.get(ALLOWLIST_URLS_KEY), 'https://new.example/list.txt');

    // e) ALLOWLIST_URLS removed: the old downloaded IPs stop being allowed (RAM and DB)
    const db4 = new FakeD1();
    db4.store.set(ALLOWLIST_KEY, encodeRanges(mergeRanges([[num('45.0.0.0'), num('45.0.0.255')]])));
    db4.store.set('guard:allowlist:updated_at', String(nowSec - 60));
    db4.store.set(ALLOWLIST_URLS_KEY, 'https://old.example/list.txt');
    const m4 = mockFetch(() => ({ body: '1.1.1.1\n' }));
    await fresh(db4, { ENABLE_RATE_LIMIT: 'true', ALLOWLIST_URLS: '', ALLOWLIST_IPS: '203.0.113.9' });
    assert.ok(!inRanges(state.allow, num('45.0.0.5')), 'stale allowlist not loaded');
    assert.ok(inRanges(state.allow, num('203.0.113.9')), 'ALLOWLIST_IPS still applies');
    assert.strictEqual(db4.store.get(ALLOWLIST_KEY), '', 'removed from the DB too');
    assert.strictEqual(m4.calls.length, 0, 'nothing to download');
    assert.strictEqual(getNextSyncAt(), Infinity);
    // and it stays removed after another boot
    await fresh(db4, { ENABLE_RATE_LIMIT: 'true', ALLOWLIST_URLS: '' });
    assert.ok(!inRanges(state.allow, num('45.0.0.5')));
  }

  // ── 20. summary log lines ─────────────────────────────────────────────────
  {
    const nowSec = Math.floor(realNow() / 1000);
    const capture = async (fn: () => Promise<unknown>): Promise<{ logs: string[]; warns: string[] }> => {
      const logs: string[] = []; const warns: string[] = [];
      console.log = (...a: any[]) => { logs.push(a.join(' ')); };
      console.warn = (...a: any[]) => { warns.push(a.join(' ')); };
      try { await fn(); } finally { quiet(); }
      return { logs, warns };
    };
    // boot from the DB: totals per country + allowlist breakdown + rate settings
    const db = new FakeD1();
    prefill(db, 'VN', ranges24(1669), nowSec - 60);
    prefill(db, 'SG', ranges24(8459, num('90.0.0.0')), nowSec - 60);
    mockFetch(() => 'fail');
    SystemSettingsModel.clearMemoryCache(); resetGuardForTests();
    let out = await capture(() => initGuard(mkEnv(db, {
      ENABLE_ALLOW_COUNTRIES: 'true', ALLOW_COUNTRIES: 'VN,SG', ENABLE_RATE_LIMIT: 'true', ALLOWLIST_IPS: '203.0.113.1,203.0.113.5'
    })));
    const boot = out.logs.find((l) => l.includes('[Guard] Active:'))!;
    assert.ok(boot.includes('countryFilter=on (10,128 ranges across 2 countries: VN=1,669, SG=8,459)'), boot);
    assert.ok(boot.includes('allowlist=2 ranges (env=2, urls=0)'), boot);
    assert.ok(boot.includes('rateLimit=on (conn=500/s burst 5,000, req=2,000/s burst 20,000, penalty 5s)'), boot);

    // boot with a missing country
    const db2 = new FakeD1();
    prefill(db2, 'VN', ranges24(1669), nowSec - 60);
    SystemSettingsModel.clearMemoryCache(); resetGuardForTests();
    out = await capture(async () => { await initGuard(mkEnv(db2, { ENABLE_ALLOW_COUNTRIES: 'true', ALLOW_COUNTRIES: 'VN,SG' })); await waitSyncIdle(); });
    const boot2 = out.logs.find((l) => l.includes('[Guard] Active:'))!;
    assert.ok(boot2.includes('waiting for lists, fail-open (VN=1,669, SG=missing)'), boot2);

    // sync complete (all ok)
    const db3 = new FakeD1();
    prefill(db3, 'VN', ranges24(300), nowSec - 60);
    prefill(db3, 'SG', ranges24(300, num('90.0.0.0')), nowSec - 60);
    const env3 = await fresh(db3, { ENABLE_ALLOW_COUNTRIES: 'true', ALLOW_COUNTRIES: 'VN,SG', ALLOWLIST_URLS: 'https://a.example/l.txt' });
    mockFetch((u) => u.includes('a.example') ? { body: '45.0.0.1\n45.0.0.2\n' } : { body: toText(ranges24(350, num('60.0.0.0'))) });
    out = await capture(() => runSync(env3));
    const done = out.logs.find((l) => l.includes('Sync complete'))!;
    assert.ok(done.includes('700 geo ranges active (VN: 350, SG: 350), allowlist: 1 ranges (env=0, urls=1). Next sync in 24h.'), done);

    // sync with errors: warn line names the item and the reason, shows what stays in use
    mockFetch((u) => u.includes('a.example') ? 'fail' : { body: toText(ranges24(20, num('60.0.0.0'))) });
    out = await capture(() => runSync(env3));
    assert.ok(!out.logs.some((l) => l.includes('Sync complete')));
    const bad = out.warns.find((l) => l.includes('Sync finished with errors'))!;
    assert.ok(bad.includes('VN kept previous list (rejected: 20 ranges < min 100)'), bad);
    assert.ok(bad.includes('SG kept previous list'), bad);
    assert.ok(bad.includes('allowlist kept previous list (rejected: download produced no ranges)'), bad);
    assert.ok(bad.includes('Retry in 30 min.') && bad.includes('700 geo ranges active (VN: 350, SG: 350)'), bad);
  }

  resetGuardForTests();
  loud();
  console.log('test_guard: all assertions passed');
}

main()
  .catch((err) => { loud(); console.error(err); process.exitCode = 1; })
  .finally(() => { Date.now = realNow; (globalThis as any).fetch = realFetch; });
