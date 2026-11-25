import type {
  Profile,
  AccessPoint,
  LogEntry,
  Rule,
  FilterList,
  GlobalProfileSettings,
  TestResponse
} from "./types";
import { localDb } from "./localDb";

/** Thrown when the server refuses a manual Refresh because the previous one was too recent (HTTP 429). */
export class RefreshCooldownError extends Error {
  readonly retryAfterSec: number;

  constructor(retryAfterSec: number) {
    super("refresh_cooldown");
    this.name = "RefreshCooldownError";
    this.retryAfterSec = retryAfterSec;
  }
}

function refreshCooldownFrom(res: Response): RefreshCooldownError {
  const wait = Number(res.headers.get("Retry-After"));
  return new RefreshCooldownError(Number.isFinite(wait) && wait > 0 ? Math.ceil(wait) : 0);
}

/**
 * 包装 fetch 方法，当请求 Profile 相关接口遇到 404 (不存在或无权限) 时，直接引导前端至 404 界面
 */
export async function profileFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 404) {
    window.location.href = "/404";
  }
  return res;
}

async function fetchProfilesFromServer(): Promise<Profile[]> {
  const res = await profileFetch("/api/profiles", {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache" }
  });
  if (!res.ok) throw new Error("Failed to fetch profiles");
  return res.json();
}

/** A profiles request started early (during startup) and not yet consumed by getProfiles(). */
let prefetchedProfiles: { promise: Promise<Profile[]>; at: number } | null = null;
const PREFETCH_MAX_AGE_MS = 10_000;

/**
 * Starts loading the profile list right away, so it runs in parallel with other startup requests
 * (e.g. getMe) instead of waiting for them. The next getProfiles() call reuses this request once.
 */
export function prefetchProfiles(): void {
  const promise = fetchProfilesFromServer();
  promise.catch(() => {}); // a failure is reported to whoever consumes it via getProfiles()
  prefetchedProfiles = { promise, at: Date.now() };
}

export async function getProfiles(): Promise<Profile[]> {
  if (prefetchedProfiles) {
    const { promise, at } = prefetchedProfiles;
    prefetchedProfiles = null;
    if (Date.now() - at < PREFETCH_MAX_AGE_MS) return promise;
  }
  return fetchProfilesFromServer();
}

export async function getProfileDetails(profileId: string): Promise<Profile> {
  const res = await profileFetch(`/api/profiles/${profileId}`);
  if (!res.ok) throw new Error("Failed to fetch profile details");
  return res.json();
}

export async function createProfile(name: string, is_default?: boolean, apply_default_filters?: boolean): Promise<Profile> {
  const res = await profileFetch("/api/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, is_default, apply_default_filters })
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteProfile(id: string, newDefaultProfileId?: string): Promise<void> {
  const url = newDefaultProfileId ? `/api/profiles/${id}?new_default_id=${encodeURIComponent(newDefaultProfileId)}` : `/api/profiles/${id}`;
  const res = await profileFetch(url, { method: "DELETE" });
  if (!res.ok) throw new Error(await res.text());
}

export async function updateProfileSettings(profileId: string, settings: GlobalProfileSettings): Promise<void> {
  const res = await profileFetch(`/api/profiles/${profileId}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings)
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function getProfileLists(profileId: string): Promise<FilterList[]> {
  const res = await profileFetch(`/api/profiles/${profileId}/lists`);
  if (!res.ok) throw new Error("Failed to fetch lists");
  return res.json();
}

/** Result of testing one domain against a single external list's bloom filter. */
export interface ListCheckResult {
  domain: string;
  blocked: boolean;
  whitelisted?: boolean;
  /** The entry that matched: the domain itself, or a parent when a wildcard higher up matched. */
  matchedEntry?: string | null;
  /** False when the list has not finished syncing, so no filter exists yet. */
  synced: boolean;
  /** 64-bit fingerprint collision floor (~1e-13) when matched via the fingerprint set; 0 for deterministic regex/exception matches. */
  falsePositiveRate?: number;
  /** Whether the list is currently active. A disabled list still keeps its stored filter. */
  enabled?: boolean;
}

/**
 * Asks whether a list blocks a domain. External lists are stored only as bloom
 * filters, so their entries cannot be listed or substring-searched - but
 * membership is answerable in microseconds, which is what the UI needs.
 */
export async function checkDomainAgainstList(
  profileId: string,
  listId: number,
  domain: string
): Promise<ListCheckResult> {
  const res = await profileFetch(
    `/api/profiles/${profileId}/lists/${listId}/check?domain=${encodeURIComponent(domain)}`
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/**
 * Enables or disables an external list without deleting it. Disabled lists are
 * skipped by the sync orchestrator and excluded when the merged profile bloom
 * is rebuilt, so the subscription and its sync history are preserved.
 */
export async function toggleProfileList(profileId: string, listId: number, enabled: boolean): Promise<void> {
  const res = await profileFetch(`/api/profiles/${profileId}/lists/${listId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled })
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function addCustomProfileList(profileId: string, url: string): Promise<{ id?: number }> {
  const res = await profileFetch(`/api/profiles/${profileId}/lists`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url })
  });
  if (!res.ok) throw new Error(await res.text());
  try {
    return await res.json();
  } catch {
    return {};
  }
}

export async function deleteCustomProfileList(profileId: string, listId: number): Promise<void> {
  const res = await profileFetch(`/api/profiles/${profileId}/lists`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: listId })
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function syncProfileLists(profileId: string): Promise<void> {
  const res = await profileFetch(`/api/profiles/${profileId}/lists/sync`, {
    method: "POST"
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function syncSingleProfileList(profileId: string, listId: number): Promise<void> {
  const res = await profileFetch(`/api/profiles/${profileId}/lists/${listId}/sync`, {
    method: "POST"
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function getProfileRules(profileId: string): Promise<Rule[]> {
  const res = await profileFetch(`/api/profiles/${profileId}/rules`);
  if (!res.ok) throw new Error("Failed to fetch rules");
  return res.json();
}

export async function addProfileRule(profileId: string, rule: Omit<Rule, "id">): Promise<void> {
  const res = await profileFetch(`/api/profiles/${profileId}/rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rule)
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function addProfileRulesBulk(profileId: string, rules: Omit<Rule, "id">[]): Promise<{ count: number }> {
  const res = await profileFetch(`/api/profiles/${profileId}/rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rules)
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function addProfileListsBulk(
  profileId: string,
  urls: (string | { url: string; enabled?: boolean | number })[]
): Promise<{ count: number }> {
  const res = await profileFetch(`/api/profiles/${profileId}/lists`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(urls)
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateProfileRule(profileId: string, rule: Rule): Promise<void> {
  const res = await profileFetch(`/api/profiles/${profileId}/rules`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rule)
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function deleteProfileRule(profileId: string, ruleId: number): Promise<void> {
  const res = await profileFetch(`/api/profiles/${profileId}/rules`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: ruleId })
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function getProfileAccessPoints(profileId: string): Promise<AccessPoint[]> {
  const res = await profileFetch(`/api/profiles/${profileId}/access_points`);
  if (!res.ok) throw new Error("Failed to fetch access points");
  return res.json();
}

export async function addProfileAccessPoint(profileId: string, name: string): Promise<AccessPoint> {
  const res = await profileFetch(`/api/profiles/${profileId}/access_points`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteProfileAccessPoint(profileId: string, apId: string, newDefaultId?: string): Promise<void> {
  const query = newDefaultId ? `?new_default_id=${encodeURIComponent(newDefaultId)}` : "";
  const res = await profileFetch(`/api/profiles/${profileId}/access_points/${apId}${query}`, {
    method: "DELETE"
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function renameProfileAccessPoint(profileId: string, apId: string, name: string): Promise<void> {
  const res = await profileFetch(`/api/profiles/${profileId}/access_points/${apId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function rotateProfileAccessPointToken(profileId: string, apId: string): Promise<{ token: string }> {
  const res = await profileFetch(`/api/profiles/${profileId}/access_points/${apId}/rotate_token`, {
    method: "POST"
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function setDefaultAccessPoint(profileId: string, apId: string): Promise<void> {
  const res = await profileFetch(`/api/profiles/${profileId}/access_points/${apId}/set_default`, {
    method: "POST"
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function getProfileLogs(profileId: string, queryParams: string, options?: { signal?: AbortSignal }): Promise<LogEntry[]> {
  const query = queryParams.startsWith("?") ? queryParams.slice(1) : queryParams;
  const res = await profileFetch(`/api/profiles/${profileId}/logs?${query}`, { signal: options?.signal });
  if (res.status === 429) throw refreshCooldownFrom(res);
  if (!res.ok) throw new Error("Failed to fetch logs");
  return res.json();
}

export async function exportProfileLogs(profileId: string, queryParams: string): Promise<any[]> {
  const query = queryParams.startsWith("?") ? queryParams.slice(1) : queryParams;
  const res = await profileFetch(`/api/profiles/${profileId}/logs/export?${query}`);
  if (!res.ok) throw new Error("Failed to export logs");
  return res.json();
}

export async function getProfileLogDetails(
  profileId: string,
  logId: number,
  timestamp?: number,
  options?: { signal?: AbortSignal }
): Promise<LogEntry> {
  const query = timestamp !== undefined ? `?timestamp=${timestamp}` : "";
  const res = await profileFetch(`/api/profiles/${profileId}/logs/${logId}${query}`, { signal: options?.signal });
  if (!res.ok) throw new Error("Failed to fetch log details");
  return res.json();
}

export async function clearProfileLogs(profileId: string): Promise<void> {
  const res = await profileFetch(`/api/profiles/${profileId}/logs`, {
    method: "DELETE"
  });
  if (!res.ok) throw new Error(await res.text());
  try {
    await localDb.clearProfile(profileId);
  } catch (err) {
    console.warn("[clearProfileLogs] Failed to clear local DB cache:", err);
  }
}

export async function getProfileAnalytics(profileId: string, type: string, queryParams: string, options?: { signal?: AbortSignal }): Promise<any> {
  const query = queryParams.startsWith("?") ? queryParams.slice(1) : queryParams;
  const path = type ? `/${type}` : "";
  const res = await profileFetch(`/api/profiles/${profileId}/analytics${path}?${query}`, { signal: options?.signal });
  if (res.status === 429) throw refreshCooldownFrom(res);
  if (!res.ok) throw new Error(`Failed to fetch analytics${type ? ` for ${type}` : ""}`);
  return res.json();
}

export async function probeUpstream(profileId: string, upstream: string | string[]): Promise<{ ok: boolean; latency: number; error?: string }> {
  const primaryUpstream = Array.isArray(upstream) ? upstream[0] || "" : upstream;
  const res = await profileFetch(`/api/profiles/${profileId}/probe_upstream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ upstream: primaryUpstream })
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(errorText || "Upstream probe failed");
  }
  return res.json();
}

export async function testResolution(profileId: string, payload: { domain: string; type: string }): Promise<TestResponse> {
  const res = await profileFetch(`/api/profiles/${profileId}/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error("Resolution test failed");
  return res.json();
}

export async function updateProfile(profileId: string, payload: { name?: string; is_default?: boolean }): Promise<void> {
  const res = await profileFetch(`/api/profiles/${profileId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function renameProfile(profileId: string, name: string, is_default?: boolean): Promise<void> {
  return updateProfile(profileId, { name, is_default });
}
