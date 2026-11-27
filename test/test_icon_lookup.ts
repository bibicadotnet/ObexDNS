import {
  getIconConfig,
  lookupWebsiteIcon,
  iconHitResponse,
  iconMissResponse,
  iconErrorResponse,
  type IconConfig,
} from "../src/utils/websiteIcon";

function eq(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

// ---- config: defaults, overrides, invalid values fall back
delete process.env.ICON_CACHE_TTL_SEC;
eq(getIconConfig({} as any), { cacheTtlSec: 86400, concurrency: 4, delayMs: 10, timeoutMs: 100 }, "defaults");
eq(
  getIconConfig({ ICON_CACHE_TTL_SEC: "600", ICON_FETCH_CONCURRENCY: "6", ICON_FETCH_DELAY_MS: "0", ICON_FETCH_TIMEOUT_MS: "250" } as any),
  { cacheTtlSec: 600, concurrency: 6, delayMs: 0, timeoutMs: 250 },
  "overrides",
);
eq(getIconConfig({ ICON_CACHE_TTL_SEC: "abc" } as any).cacheTtlSec, 86400, "invalid ttl falls back");
eq(getIconConfig({ ICON_FETCH_CONCURRENCY: "0" } as any).concurrency, 4, "concurrency below 1 falls back to the default");

// ---- fake Google
const calls: { host: string; url: string; at: number }[] = [];
const requested = () => calls.map((c) => c.host);
let active = 0;
let maxActive = 0;
const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const globe = new Uint8Array([71, 76, 79, 66, 69, 0, 1, 2, 3]); // the body Google sends along with a 404
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const host = new URL(String(input)).searchParams.get("url")!.replace(/^http:\/\//, "");
  calls.push({ host, url: String(input), at: Date.now() });
  active++;
  maxActive = Math.max(maxActive, active);
  try {
    if (host.startsWith("hang")) {
      await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    await new Promise((r) => setTimeout(r, 20));
    if (host.startsWith("nofav")) {
      return new Response(globe, { status: 404, headers: { "Content-Type": "image/png" } });
    }
    if (host.startsWith("limited")) return new Response("slow down", { status: 429 });
    if (host.startsWith("boom")) throw new Error("network down");
    if (host.startsWith("html")) return new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } });
    return new Response(png, { status: 200, headers: { "Content-Type": "image/png" } });
  } finally {
    active--;
  }
}) as any;

const cfg: IconConfig = { cacheTtlSec: 86400, concurrency: 1, delayMs: 40, timeoutMs: 1000 };

async function main() {
  // hit on the host itself: one request, exactly the Google URL
  const hit = await lookupWebsiteIcon("github.com", cfg);
  eq(hit.kind, "hit", "hit");
  eq(requested(), ["github.com"], "one request for a hit");
  eq(calls[0].url, "https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://github.com&size=16", "direct gstatic url, no redirect hop");

  // no favicon for the host (404 + globe): the registrable domain is asked, and its icon is used
  calls.length = 0;
  eq((await lookupWebsiteIcon("nofav.chat.example.org", cfg)).kind, "hit", "falls back to the parent domain");
  eq(requested(), ["nofav.chat.example.org", "example.org"], "host, then registrable domain (not the middle label)");

  // neither host nor parent has a favicon: a final miss, two requests at most
  calls.length = 0;
  eq((await lookupWebsiteIcon("nofav.nofav-site.com", cfg)).kind, "miss", "no icon anywhere");
  eq(requested(), ["nofav.nofav-site.com", "nofav-site.com"], "two requests at most");

  // host does not answer in time: the parent is tried
  calls.length = 0;
  const fast = { ...cfg, timeoutMs: 30 };
  eq((await lookupWebsiteIcon("hang.example.org", fast)).kind, "hit", "timeout falls back to the parent");
  eq(requested(), ["hang.example.org", "example.org"], "timeout then parent");

  // uncertain outcomes are errors, never misses: host has no icon but the parent did not answer, and the reverse
  eq((await lookupWebsiteIcon("nofav.hang-site.com", fast)).kind, "error", "host miss + parent timeout is uncertain");
  eq((await lookupWebsiteIcon("hang.nofav-site.com", fast)).kind, "error", "host timeout + parent miss is uncertain");
  eq((await lookupWebsiteIcon("limited.limited-x.com", cfg)).kind, "error", "429 is error");
  eq((await lookupWebsiteIcon("boom.boom-x.com", cfg)).kind, "error", "network failure is error");

  // a 200 that is not an image is unusable, i.e. a final miss
  eq((await lookupWebsiteIcon("html.html-x.com", cfg)).kind, "miss", "non-image 200 is unusable");

  // iconless names never leave the server
  calls.length = 0;
  eq((await lookupWebsiteIcon("4.3.2.1.in-addr.arpa", cfg)).kind, "miss", "PTR miss");
  eq(calls.length, 0, "PTR sends no request");

  // burst: strictly sequential with concurrency 1, spaced, identical requests shared
  calls.length = 0;
  maxActive = 0;
  const hosts = ["a.example.com", "b.example.com", "c.example.com", "a.example.com", "a.example.com"];
  const results = await Promise.all(hosts.map((h) => lookupWebsiteIcon(h, cfg)));
  eq(results.every((r) => r.kind === "hit"), true, "burst results");
  eq(requested().length, 3, "duplicates share one request");
  eq(maxActive, 1, "strictly sequential with concurrency 1");
  for (let i = 1; i < calls.length; i++) {
    const gap = calls[i].at - calls[i - 1].at;
    if (gap < 20 + 40 - 8) throw new Error(`pause not respected: gap ${gap}ms`);
  }

  // two subdomains of the same parent share one request for the parent
  calls.length = 0;
  await Promise.all([lookupWebsiteIcon("nofav-a.example.org", cfg), lookupWebsiteIcon("nofav-b.example.org", cfg)]);
  eq(requested().sort(), ["example.org", "nofav-a.example.org", "nofav-b.example.org"], "parent requested once");

  // concurrency 4 is honoured (let the previous test's slots finish their pause first)
  await new Promise((r) => setTimeout(r, 120));
  calls.length = 0;
  maxActive = 0;
  const cfg4 = { ...cfg, concurrency: 4, delayMs: 0 };
  await Promise.all(["p", "q", "r", "s", "t", "u"].map((l) => lookupWebsiteIcon(`${l}.example.net`, cfg4)));
  eq(maxActive, 4, "concurrency 4");

  // responses: hit/miss carry the TTL, error is never cached
  const h = iconHitResponse((hit as any).icon, 600);
  eq([h.status, h.headers.get("Cache-Control")], [200, "public, max-age=600"], "hit headers");
  const m = iconMissResponse(600);
  eq([m.status, m.headers.get("Cache-Control")], [404, "public, max-age=600"], "miss headers");
  const e = iconErrorResponse();
  eq([e.status, e.headers.get("Cache-Control")], [502, "no-store"], "error headers");

  globalThis.fetch = realFetch;
  console.log("test_icon_lookup: OK");
}
main().catch((err) => { console.error(err); process.exit(1); });
