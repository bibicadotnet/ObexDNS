import { Env } from "../../types";
import { BloomFilter } from "../bloom";
import { fetchListContent } from "../listFetcher";
import { ListModel } from "../../models/list";
import { ListBloomModel } from "../../models/listBloom";
import { SystemListModel } from "../../models/systemList";
import { AdguardRulesModel } from "../../models/adguardRules";
import { AdGuardRuleKind, AdGuardPayload, ParsedAdGuardRule } from "../../lib/adguard";
import { systemListsManager } from "../../lib/filtering/systemListsManager";
import { syncSingleSystemList } from "./systemListSync";

const DEFAULT_MAX_LIST_BYTES = 25 * 1024 * 1024; // 25 MB default limit (streaming line parsing has low memory footprint)

export interface SingleListSyncResult {
  syncError: string | null;
  notModified: boolean;
}

/**
 * 同步单个订阅列表的通用业务逻辑。
 * 
 * 性能优化：
 * 1. 系统共享列表 (System Shared Lists) 零下载零构建，直接复用全局系统 Bloom。
 * 2. 支持 HTTP 304 Not Modified 协商缓存，未变更列表 0 CPU/存储消耗。
 * 3. 使用流式下载与行解析，直接在下载过程中动态将域名填入布隆过滤器。
 * 4. 采用 addPipePipe 零堆内存分配 FNV 前缀哈希，消除数十万次字符串拼接。
 * 5. 协作式调度每批出让 CPU 喘息，规避 CPU 超载。
 * 
 * @returns 最终的同步结果包含错误信息及是否命中未修改缓存
 */
export async function syncSingleList(
  profileId: string,
  list: { id: number; url: string; etag?: string | null; last_modified?: string | null },
  env: Env,
  listModel: ListModel,
  listBloomModel: ListBloomModel,
  now: number,
  force: boolean = false
): Promise<SingleListSyncResult> {
  // ── 系统共享列表快速通道 (System Shared List Fast Path) ───────────────────
  if (env?.DB) {
    await systemListsManager.ensureLoaded(env.DB);
    if (systemListsManager.isSystemUrl(list.url)) {
      const sysId = systemListsManager.getIdByUrl(list.url);
      if (sysId) {
        if (force) {
          await syncSingleSystemList(sysId, env, true);
        }
        const sysModel = new SystemListModel(env.DB);
        const sysList = await sysModel.getSystemListById(sysId);
        await listModel.updateListSyncStatus(
          list.id,
          sysList?.last_synced_at || now,
          null,
          sysList?.sync_error || null,
          sysList?.etag || null,
          sysList?.last_modified || null
        );
        return { syncError: sysList?.sync_error || null, notModified: true };
      }
    }
  }
  const timeoutMs = Number(env.SYNC_TIMEOUT_MS) || 90000;
  const maxListDomains = Number(env.MAX_LIST_DOMAINS) || 500000;
  const maxDomains = Number(env.MAX_SYNC_DOMAINS) || 1000000;
  const maxListBytes = Number(env.MAX_LIST_BYTES) || DEFAULT_MAX_LIST_BYTES;
  const falsePositiveRate = Number(env.BLOOM_FALSE_POSITIVE_RATE) || 0.0001;
  const maxRegexRules = Number(env.MAX_REGEX_RULES) || 1000;

  // 协作式调度参数：降低单次持续计算量，适度平摊 CPU 峰值
  const yieldBatchSize = Number(env.SYNC_YIELD_BATCH_SIZE) || 5000;
  const yieldSleepMs = Number(env.SYNC_YIELD_SLEEP_MS) || 10;

  // 创建对应的列表布隆过滤器与扩展规则载荷
  const listBloom = BloomFilter.create(maxDomains, falsePositiveRate);
  const adguardPayload: AdGuardPayload = {
    exceptions: [],
    rewrites: {},
    patterns: []
  };

  let count = 0;
  let domainsSinceYield = 0;

  // 检查已有布隆过滤器是否为最新版本 (v2)；若不是最新版或被指定 force，则忽略 ETag/304 强制重新下载并构建
  const existingBloom = await listBloomModel.getListBloom(list.id);
  const isBloomCurrent = BloomFilter.isCurrentVersion(existingBloom);
  const useCacheHeaders = !force && isBloomCurrent;

  // 流式下载并按行解析规则，分流分类存储，携带协商缓存头
  const { error: fetchError, truncated, notModified, etag, lastModified } = await fetchListContent(
    list.url,
    maxListBytes,
    timeoutMs,
    (rule: ParsedAdGuardRule) => {
      if (count < maxListDomains) {
        if (rule.kind === AdGuardRuleKind.BLOOM_DOMAIN && rule.domain) {
          if (rule.includeSubdomains) {
            // 零内存分配：预计算前缀哈希种子，无需拼接产生新字符串
            listBloom.addPipePipe(rule.domain);
          } else {
            listBloom.add(rule.domain);
          }
          count++;
        } else if (rule.kind === AdGuardRuleKind.EXCEPTION && rule.domain) {
          adguardPayload.exceptions.push({
            domain: rule.domain,
            includeSubdomains: Boolean(rule.includeSubdomains),
            raw: rule.raw
          });
          count++;
        } else if (rule.kind === AdGuardRuleKind.DNS_REWRITE && rule.domain && rule.rewrite) {
          adguardPayload.rewrites[rule.domain] = {
            ...rule.rewrite,
            includeSubdomains: Boolean(rule.includeSubdomains),
            raw: rule.raw
          };
          count++;
        } else if (rule.kind === AdGuardRuleKind.COMPLEX_PATTERN && rule.patternRegex) {
          if (adguardPayload.patterns.length < maxRegexRules) {
            adguardPayload.patterns.push({
              pattern: rule.patternRegex,
              apexIndex: rule.apexIndex,
              raw: rule.raw
            });
            count++;
          }
        }

        domainsSinceYield++;

        // 协作式调度：每处理 yieldBatchSize 个规则让出事件循环，注入喘息延迟平摊 CPU 负载
        if (domainsSinceYield >= yieldBatchSize) {
          domainsSinceYield = 0;
          return new Promise<void>((resolve) => setTimeout(resolve, yieldSleepMs));
        }
      }
    },
    useCacheHeaders ? { etag: list.etag, lastModified: list.last_modified } : {}
  );

  // 协商缓存命中：上游规则未发生变动，直接沿用原有布隆与规则，跳过数据库覆写与后续合并计算
  if (notModified) {
    console.log(`[Sync] Profile ${profileId}: list #${list.id} 304 Not Modified (using cached rules).`);
    await listModel.updateListSyncStatus(list.id, now, null, null, etag, lastModified);
    return { syncError: null, notModified: true };
  }

  let syncError: string | null = fetchError;

  if (!fetchError) {
    if (truncated) {
      syncError = `List truncated at ${(maxListBytes / 1024 / 1024).toFixed(0)} MB: Maximum list size reached. Excess rules were omitted.`;
      console.warn(
        `[Sync] Profile ${profileId}: list #${list.id} truncated at ${(maxListBytes / 1024 / 1024).toFixed(0)} MB with ${count} rules. Warning: ${syncError}`
      );
    }
    // 写入列表级布隆过滤器和扩展规则到数据库
    const saveOps: Promise<any>[] = [
      listBloomModel.upsertListBloom(list.id, listBloom.toUint8Array().buffer as ArrayBuffer, now)
    ];
    if (env?.DB) {
      saveOps.push(new AdguardRulesModel(env.DB).upsertListRules(list.id, adguardPayload, now));
    }
    await Promise.all(saveOps);
    if (!truncated) {
      console.log(
        `[Sync] Profile ${profileId}: successfully updated list #${list.id} with ${count} rules.`
      );
    }
  } else {
    // 拉取失败：跳过，并沿用原有列表缓存，记录错误原因，保持启用状态
    console.warn(
      `[Sync] Profile ${profileId}: failed to fetch/parse list #${list.id}. ` +
        `Skipping and keeping old bloom. Error: ${fetchError}`
    );
  }

  // 无论成功还是失败，都更新 last_synced_at、etag、last_modified 并记录 syncError
  await listModel.updateListSyncStatus(list.id, now, null, syncError, etag, lastModified);
  return { syncError, notModified: false };
}
