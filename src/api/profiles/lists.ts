import { Env, User, ExecutionContext } from "../../types";
import { ListModel } from "../../models/list";
import { ProfileModel } from "../../models/profile";
import { SystemListModel } from "../../models/systemList";
import {
  syncNextListForProfile,
  syncAllListsForProfile,
  syncSingleListForProfile,
  syncSingleSystemList,
  syncAllSystemLists
} from "../../utils/sync";
import { isSafeUrl } from "../../utils/validator";
import { pipeline } from "../../pipeline";
import { ListFilterModel } from "../../models/listFilter";
import { FingerprintSet } from "../../utils/fingerprintSet";
import { AdguardRulesModel } from "../../models/adguardRules";
import { AdGuardProfileEngine } from "../../lib/adguard";
import { systemListsManager } from "../../lib/filtering/systemListsManager";
import { customListsManager } from "../../lib/filtering/customListsManager";
import { getDefaultProfileFilterUrls } from "../../constants/presets";

/**
 * Handle filter lists requests to /api/profiles/:id/lists
 */
export async function handleProfileListsRequest(
  request: Request,
  env: Env,
  user: User,
  profileId: string,
  pathParts: string[],
  ctx: ExecutionContext
): Promise<Response> {
  const listModel = new ListModel(env.DB);
  const profileModel = new ProfileModel(env.DB);

  if (request.method === 'GET') {
    // GET /api/profiles/:id/lists/:listId/check?domain=example.com
    //
    // Answers "does this list block this domain" straight from the list's own
    // Fingerprint Filter, walking parent domains exactly as pipeline/filter.ts does.
    // External lists are stored only as Fingerprint Filters, so their entries cannot
    // be enumerated or substring-searched - but membership is answerable in
    // microseconds, which is the question the UI actually asks.
    if (pathParts[5] === 'check') {
      const listId = Number(pathParts[4]);
      if (!Number.isInteger(listId) || listId <= 0) {
        return new Response("Invalid list id", { status: 400 });
      }

      const rawDomain = (new URL(request.url).searchParams.get('domain') || '').trim().toLowerCase();
      // Strip trailing dots (e.g. FQDN "example.com.") to match DNS labels correctly
      const domain = rawDomain.replace(/\.+$/, '');
      if (!domain || domain.length > 253 || !/^[a-z0-9._-]+$/.test(domain)) {
        return new Response("Invalid or missing domain parameter", { status: 400 });
      }

      const list = await listModel.getListById(listId, profileId);
      if (!list) return new Response("List Not Found", { status: 404 });

      let filter: FingerprintSet | null = null;
      let adguardEngine: AdGuardProfileEngine | null = null;

      await systemListsManager.ensureLoaded(env.DB, false, env);
      const isSystemList = systemListsManager.isSystemUrl(list.url);

      if (isSystemList) {
        const sysId = systemListsManager.getIdByUrl(list.url);
        if (sysId) {
          filter = systemListsManager.getBloom(sysId);
          adguardEngine = systemListsManager.getAdguard(sysId);
        }
      } else {
        filter = customListsManager.getFilter(listId);
        adguardEngine = customListsManager.getAdguard(listId);
      }

      // If not present in memory cache, load from DB
      if (!filter && !adguardEngine) {
        let buffer: ArrayBuffer | null = null;
        let adguardPayload: any = null;

        if (isSystemList) {
          const sysId = systemListsManager.getIdByUrl(list.url);
          if (sysId) {
            const sysModel = new SystemListModel(env.DB);
            buffer = await sysModel.getSystemListFilter(sysId);
            adguardPayload = await sysModel.getSystemListAdguard(sysId);
          }
        } else {
          buffer = await new ListFilterModel(env.DB).getListFilter(listId);
          const adguardRulesModel = env.DB ? new AdguardRulesModel(env.DB) : null;
          adguardPayload = adguardRulesModel ? await adguardRulesModel.getListRules(listId) : null;
        }

        if (buffer && FingerprintSet.isCurrentVersion(buffer)) {
          try {
            filter = FingerprintSet.fromUint8Array(new Uint8Array(buffer));
          } catch (err: any) {
            console.error(`[Lists] Failed to deserialize Fingerprint Filter for list #${listId}:`, err?.message || err);
          }
        }
        if (adguardPayload) {
          adguardEngine = new AdGuardProfileEngine(adguardPayload);
        }
      }

      if (!filter && !adguardEngine) {
        return new Response(JSON.stringify({ domain, blocked: false, synced: false }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // ── 阶段 1：AdGuard 白名单例外 (@@) ──────────────────────────────────────
      const exceptionMatch = adguardEngine?.findException(domain);
      if (exceptionMatch) {
        return new Response(JSON.stringify({
          domain,
          blocked: false,
          whitelisted: true,
          matchedEntry: exceptionMatch,
          falsePositiveRate: 0,
          enabled: !!list.enabled,
          synced: true
        }), { headers: { 'Content-Type': 'application/json' } });
      }

      // ── 阶段 2：Fingerprint 过滤器双态前缀检查 ────────────────────────────────────
      let currentDomain = domain;
      let isSelf = true;
      let matched: string | null = null;
      if (filter) {
        while (currentDomain) {
          if (isSelf) {
            // 精确自身测试：匹配单域名黑名单 或 带有 || 的自身
            if (filter.test(currentDomain) || filter.testPipePipe(currentDomain)) {
              matched = currentDomain;
              break;
            }
            isSelf = false;
          } else {
            // 父级子域测试：仅当父域名是以 || 前缀注册时才拦截子域！
            if (filter.testPipePipe(currentDomain)) {
              matched = currentDomain;
              break;
            }
          }
          const firstDot = currentDomain.indexOf('.');
          if (firstDot === -1) break;
          currentDomain = currentDomain.substring(firstDot + 1);
        }
      }

      // ── 阶段 3：AdGuard 正则与复杂通配符池 (Regex / Wildcard Pool) ───────────
      if (!matched && adguardEngine) {
        const patternMatch = adguardEngine.findPattern(domain);
        if (patternMatch) {
          matched = patternMatch.raw || patternMatch.pattern || domain;
        }
      }

      // ── 阶段 4：AdGuard DNS 重写规则 ($dnsrewrite) ───────────────────────────
      if (!matched && adguardEngine) {
        const rewriteMatch = adguardEngine.findRewrite(domain);
        if (rewriteMatch) {
          matched = rewriteMatch.raw || `${domain}$dnsrewrite=${rewriteMatch.action.value || rewriteMatch.action.type}`;
        }
      }

      return new Response(JSON.stringify({
        domain,
        blocked: matched !== null,
        whitelisted: false,
        matchedEntry: matched,
        // FingerprintSet is deterministic; the only residual "false positive" is the 64-bit hash
        // collision floor (~1e-13), which is not tunable. Regex/exception matches are exact (0).
        falsePositiveRate: matched && filter ? 1e-13 : 0,
        enabled: !!list.enabled,
        synced: true
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    const results = await listModel.getLists(profileId);
    // Resolve a human-readable name per list: system lists carry an admin label / parsed
    // title in system_lists.name, custom lists keep the title parsed from their own header.
    await systemListsManager.ensureLoaded(env.DB, false, env);
    // Lists the admin configured via DEFAULT_PROFILE_FILTER_URLS are the recommended defaults: flag them for the UI.
    const defaultUrls = new Set(getDefaultProfileFilterUrls(env).map((u) => u.trim().toLowerCase()));
    const named = results.map((l) => ({
      ...l,
      title: systemListsManager.getNameByUrl(l.url) || l.title || null,
      description: systemListsManager.getDescriptionByUrl(l.url) || l.description || null,
      is_default: defaultUrls.has(l.url.trim().toLowerCase())
    }));
    return new Response(JSON.stringify(named), { headers: { 'Content-Type': 'application/json' } });
  }

  if (request.method === 'PATCH') {
    const listId = Number(pathParts[4]);
    if (!Number.isInteger(listId) || listId <= 0) {
      return new Response("Invalid list id", { status: 400 });
    }

    let body: { enabled?: unknown };
    try {
      body = await request.json() as { enabled?: unknown };
    } catch {
      return new Response("Body must be { enabled: boolean }", { status: 400 });
    }
    if (typeof body.enabled !== 'boolean') {
      return new Response("Body must be { enabled: boolean }", { status: 400 });
    }

    const list = await listModel.getListById(listId, profileId);
    if (!list) return new Response("List Not Found", { status: 404 });

    const updated = await listModel.setEnabled(listId, profileId, body.enabled);
    if (!updated) {
      return new Response("Failed to update list", { status: 500 });
    }

    // Load first: isSystemUrl reads the in-memory map, which is empty in a fresh process.
    await systemListsManager.ensureLoaded(env.DB, false, env);
    const isSystemList = systemListsManager.isSystemUrl(list.url);

    // If enabling a list that was never synced before, trigger immediate sync
    if (body.enabled) {
      if (isSystemList) {
        const sysId = systemListsManager.getIdByUrl(list.url);
        if (sysId) {
          const sysModel = new SystemListModel(env.DB);
          const sysList = await sysModel.getSystemListById(sysId);
          if (!sysList?.last_synced_at) {
            ctx.waitUntil(
              syncSingleSystemList(sysId, env, false)
                .then(() => systemListsManager.ensureLoaded(env.DB, true, env))
                .then(() => pipeline.clearCache(profileId, true, env))
            );
          }
        }
      } else if (!list.last_synced_at) {
        ctx.waitUntil(
          syncSingleListForProfile(profileId, listId, env, ctx, false)
        );
      }
    }

    // System lists and custom lists both run independently per-list.
    // Toggling only clears profile config cache to reload enabled list IDs; filters stay in RAM.
    ctx.waitUntil(
      pipeline.clearCache(profileId, false, env)
        .catch((e) => console.error(`[Lists] cache clear failed for ${profileId}:`, e))
    );

    return new Response(JSON.stringify({ id: listId, enabled: body.enabled }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (request.method === 'POST') {
    if (pathParts[4] === 'sync') {
      // 触发所有列表的同步 (支持 ?force=true 强制重新下载)
      const url = new URL(request.url);
      const force = url.searchParams.get('force') === 'true';
      ctx.waitUntil(
        syncAllSystemLists(env, force, profileId)
          .then(() => syncAllListsForProfile(profileId, env, ctx, force))
      );
      return new Response(JSON.stringify({ message: "Sync started" }), { status: 202 });
    }

    if (pathParts.length >= 6 && pathParts[5] === 'sync') {
      const listId = Number(pathParts[4]);
      if (!Number.isInteger(listId) || listId <= 0) {
        return new Response("Invalid list id", { status: 400 });
      }

      const list = await listModel.getListById(listId, profileId);
      if (!list) return new Response("List Not Found", { status: 404 });

      const url = new URL(request.url);
      const force = url.searchParams.get('force') === 'true';
      await systemListsManager.ensureLoaded(env.DB, false, env);
      if (systemListsManager.isSystemUrl(list.url)) {
        const sysId = systemListsManager.getIdByUrl(list.url);
        if (sysId) {
          // Cache pipeline của các profile liên quan đã được xóa bên trong syncSingleSystemList
          // khi nội dung thật sự thay đổi; 304 Not Modified thì giữ nguyên cache nóng.
          ctx.waitUntil(
            syncSingleSystemList(sysId, env, force)
              .catch((e) => console.error(`[Lists] System list sync failed for #${sysId}:`, e))
          );
        }
      } else {
        ctx.waitUntil(syncSingleListForProfile(profileId, listId, env, ctx, force));
      }
      return new Response(JSON.stringify({ message: "List sync started", id: listId }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const body = await request.json() as any;
    const MAX_CUSTOM_LISTS = Number(env?.MAX_CUSTOM_LISTS_PER_PROFILE) || 5;
    await systemListsManager.ensureLoaded(env.DB, false, env);
    const existingLists = await listModel.getLists(profileId);
    const currentCustomCount = existingLists.filter(l => !systemListsManager.isSystemUrl(l.url)).length;

    // Support bulk list addition when body is an array or contains lists/urls/filters/blocklists array
    const candidateList = Array.isArray(body)
      ? body
      : (body?.lists || body?.list || body?.urls || body?.url || body?.filters || body?.filter || body?.blocklists || body?.blocklist);

    const isBulk = Array.isArray(candidateList);
    if (isBulk) {
      const rawList: any[] = candidateList;
      const seen = new Set<string>();
      const validItems: { url: string; enabled: number }[] = [];

      for (const item of rawList) {
        let urlStr = typeof item === 'string'
          ? item.trim()
          : (item?.url ?? item?.link ?? item?.uri ?? item?.address ?? item?.source ?? item?.target ?? item?.download_url ?? '');
        if (typeof urlStr !== 'string') continue;
        urlStr = urlStr.replace(/^["']|["']$/g, '').trim();
        if (urlStr.startsWith('//')) {
          urlStr = `https:${urlStr}`;
        } else if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
          if (urlStr.includes('.') && !urlStr.includes(' ') && urlStr.length > 3) {
            urlStr = `https://${urlStr}`;
          } else {
            continue;
          }
        }
        if (!isSafeUrl(urlStr)) continue;
        const norm = urlStr.toLowerCase();
        if (seen.has(norm)) continue;
        seen.add(norm);

        const enabled = (item && typeof item === 'object' && item.enabled !== undefined)
          ? (item.enabled ? 1 : 0)
          : 1;
        validItems.push({ url: urlStr, enabled });
      }

      if (validItems.length === 0) {
        return new Response(JSON.stringify({ count: 0, message: "No valid URLs provided" }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const existingUrls = new Set(existingLists.map(l => l.url.trim().toLowerCase()));
      const itemsToInsert = validItems.filter(item => !existingUrls.has(item.url.toLowerCase()));

      const nonSystemToInsert = itemsToInsert.filter(i => !systemListsManager.isSystemUrl(i.url));
      if (currentCustomCount + nonSystemToInsert.length > MAX_CUSTOM_LISTS) {
        return new Response(`Exceeded maximum limit of ${MAX_CUSTOM_LISTS} custom filter lists per profile.`, { status: 400 });
      }

      let insertedCount = 0;
      if (itemsToInsert.length > 0) {
        insertedCount = await listModel.addListsBulk(profileId, itemsToInsert);
        ctx.waitUntil(syncNextListForProfile(profileId, env, ctx));
        ctx.waitUntil(pipeline.clearCache(profileId, true, env));
      }

      return new Response(JSON.stringify({ success: true, count: insertedCount }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const rawUrl = (body as { url?: string })?.url;
    if (typeof rawUrl !== 'string') {
      return new Response("Invalid list URL format", { status: 400 });
    }
    const listUrl = rawUrl.trim();
    if (!listUrl || (!listUrl.startsWith('http://') && !listUrl.startsWith('https://'))) {
      return new Response("Invalid list URL format", { status: 400 });
    }
    if (!isSafeUrl(listUrl)) {
      return new Response("Invalid list URL. Private networks and localhosts are not allowed.", { status: 400 });
    }

    const existingUrls = new Set(existingLists.map(l => l.url.trim().toLowerCase()));
    if (existingUrls.has(listUrl.toLowerCase())) {
      return new Response("List URL already exists in this profile", { status: 400 });
    }

    if (!systemListsManager.isSystemUrl(listUrl) && currentCustomCount >= MAX_CUSTOM_LISTS) {
      return new Response(`Exceeded maximum limit of ${MAX_CUSTOM_LISTS} custom filter lists per profile.`, { status: 400 });
    }

    const insertResult = await listModel.addList(profileId, listUrl);
    const listId = insertResult.id;
    // 仅针对新添加的单条列表执行同步与规则重构合并，避免拉取和重刷所有列表
    if (listId) {
      if (systemListsManager.isSystemUrl(listUrl)) {
        const sysId = systemListsManager.getIdByUrl(listUrl);
        if (sysId) {
          ctx.waitUntil(syncSingleSystemList(sysId, env));
        }
        ctx.waitUntil(pipeline.clearCache(profileId, true, env));
      } else {
        ctx.waitUntil(syncSingleListForProfile(profileId, listId, env, ctx));
      }
    }
    return new Response(JSON.stringify({ success: true, id: listId }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (request.method === 'DELETE') {
    let id: number | undefined;
    if (pathParts.length >= 5 && pathParts[4]) {
      const parsed = Number(pathParts[4]);
      if (Number.isInteger(parsed) && parsed > 0) {
        id = parsed;
      }
    }
    if (!id) {
      try {
        const body = await request.json() as { id?: number };
        if (body && typeof body.id === 'number') {
          id = body.id;
        }
      } catch {}
    }

    if (!id || !Number.isInteger(id) || id <= 0) {
      return new Response("Invalid or missing list id", { status: 400 });
    }

    // IDOR protection: Verify the list actually belongs to this profile before deleting
    const existingList = await listModel.getListById(id, profileId);
    if (!existingList) {
      return new Response("List Not Found", { status: 404 });
    }

    await listModel.deleteList(id, profileId);
    if (env.DB) {
      const listFilterModel = new ListFilterModel(env.DB);
      const adguardModel = new AdguardRulesModel(env.DB);
      await Promise.all([
        listFilterModel.deleteListFilter(id).catch(() => {}),
        adguardModel.deleteListRules(id).catch(() => {})
      ]);
    }
    customListsManager.invalidate(id);
    ctx.waitUntil(pipeline.clearCache(profileId, false, env));
    return new Response(null, { status: 204 });
  }

  return new Response("Method Not Allowed", { status: 405 });
}