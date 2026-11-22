/**
 * @file filter.ts
 * @description Multi-tier DNS filtering pipeline combining local custom rules,
 * AdGuard exceptions, DNS rewrites, two-tier Fingerprint Filter (System Shared + Profile Custom),
 * and complex regex patterns.
 */

import { Context, DNSQuery, ResolutionResult, ProfileSettings, Rule } from "../types";
import { DNSFilter } from "../lib/filtering";
import { RewriteAction } from "../lib/adguard/types";
import { systemListsManager } from "../lib/filtering/systemListsManager";
import { customListsManager, CustomListEntry } from "../lib/filtering/customListsManager";
import { pipelineResolver } from "./resolver";

export const pipelineFilter = {
  async match(
    request: Request,
    query: DNSQuery,
    context: Context,
    settings: ProfileSettings,
    rules: Rule[],
    track: (name: string) => void,
    enabledSystemListIds?: number[],
    enabledCustomListIds?: number[]
  ): Promise<ResolutionResult | null> {
    const domainLower = query.name.toLowerCase();

    // Resolve enabled custom list entries once per query to prevent repetitive LRU Map churn
    const customEntries: { id: number; entry: CustomListEntry }[] = [];
    if (enabledCustomListIds && enabledCustomListIds.length > 0) {
      for (const id of enabledCustomListIds) {
        const entry = customListsManager.getEntry(id);
        if (entry) customEntries.push({ id, entry });
      }
    }

    // ── 阶段 1：本地自定义规则 (Local Rules) ──────────────────────────────────
    // 1.1 本地白名单
    if (DNSFilter.findByType(rules, 'ALLOW', query.name)) {
      track('local_rules');
      return pipelineResolver.resolve(request, query, context, settings, "PASS", "Whitelist");
    }

    // 1.2 本地重定向
    const redirectRule = DNSFilter.findByType(rules, 'REDIRECT', query.name);
    if (redirectRule) {
      let val: string | undefined;
      let respType = query.type;

      if (query.type === 'A') {
        val = redirectRule.v_a;
        if (!val && redirectRule.v_cname) {
          val = redirectRule.v_cname;
          respType = 'CNAME';
        }
      } else if (query.type === 'AAAA') {
        val = redirectRule.v_aaaa;
        if (!val && redirectRule.v_cname) {
          val = redirectRule.v_cname;
          respType = 'CNAME';
        }
      } else if (query.type === 'TXT') {
        val = redirectRule.v_txt;
      } else if (query.type === 'CNAME') {
        val = redirectRule.v_cname;
      }

      if (val) {
        track('local_rules');
        const result = await pipelineResolver.block(request, query, context, settings, "REDIRECT", `Rule: ${redirectRule.pattern}`, val, respType);
        return result;
      }
    }

    // 1.3 本地黑名单
    const blockRule = DNSFilter.findByType(rules, 'BLOCK', query.name);
    if (blockRule) {
      track('local_rules');
      return pipelineResolver.block(request, query, context, settings, "BLOCK", `Blacklist: ${blockRule.pattern}`);
    }
    track('local_rules');

    // ── 阶段 2：白名单例外 (@@) (Profile 自定义 + System 共享 + Custom 列表) ──
    // 2.2 System 共享例外
    if (enabledSystemListIds && enabledSystemListIds.length > 0) {
      for (const sysId of enabledSystemListIds) {
        const sysAdguard = systemListsManager.getAdguard(sysId);
        if (sysAdguard?.testException(domainLower)) {
          track('adguard_whitelist');
          return pipelineResolver.resolve(request, query, context, settings, "PASS", "System List: Exception");
        }
      }
    }
    // 2.3 Custom 列表例外
    if (customEntries.length > 0) {
      for (const { id, entry } of customEntries) {
        if (entry.engine?.testException(domainLower)) {
          track('adguard_whitelist');
          return pipelineResolver.resolve(request, query, context, settings, "PASS", `Custom List #${id}: Exception`);
        }
      }
    }

    // ── 阶段 3：DNS 重写 ($dnsrewrite) (Profile 自定义 + System 共享 + Custom 列表) ─
    let rewrite: RewriteAction | undefined;
    let rewriteLabel = "";
    if (!rewrite && enabledSystemListIds && enabledSystemListIds.length > 0) {
      for (const sysId of enabledSystemListIds) {
        const sysAdguard = systemListsManager.getAdguard(sysId);
        const r = sysAdguard?.matchRewrite(domainLower);
        if (r) {
          rewrite = r;
          rewriteLabel = "System List: DNS Rewrite";
          break;
        }
      }
    }
    if (!rewrite && customEntries.length > 0) {
      for (const { id, entry } of customEntries) {
        const r = entry.engine?.matchRewrite(domainLower);
        if (r) {
          rewrite = r;
          rewriteLabel = `Custom List #${id}: DNS Rewrite`;
          break;
        }
      }
    }
    if (rewrite) {
      track('adguard_rewrite');
      if (rewrite.type === 'A' || rewrite.type === 'AAAA') {
        if (query.type === rewrite.type || query.type === 'HTTPS' || query.type === 'SVCB') {
          return pipelineResolver.block(request, query, context, settings, "REDIRECT", rewriteLabel, rewrite.value, rewrite.type);
        }
        return pipelineResolver.block(request, query, context, settings, "BLOCK", `${rewriteLabel} (NoData)`);
      }
      if (rewrite.type === 'CNAME') {
        return pipelineResolver.block(request, query, context, settings, "REDIRECT", rewriteLabel, rewrite.value, "CNAME");
      }
      if (rewrite.type === 'NXDOMAIN') {
        return pipelineResolver.block(request, query, context, settings, "BLOCK", `${rewriteLabel} (NXDOMAIN)`);
      }
      if (rewrite.type === 'REFUSED') {
        return pipelineResolver.block(request, query, context, settings, "BLOCK", `${rewriteLabel} (REFUSED)`);
      }
    }

    // ── 阶段 4：Fingerprint 过滤器防线 (Tier 1 System + Tier 2 Custom) ──────────
    // 4.1 Tầng 1: System Shared Filter (Phủ 95%+ tên miền quảng cáo/theo dõi)
    if (enabledSystemListIds && enabledSystemListIds.length > 0) {
      for (const sysId of enabledSystemListIds) {
        const sysBloom = systemListsManager.getBloom(sysId);
        if (sysBloom) {
          let currentDomain = domainLower;
          let isSelf = true;
          while (currentDomain) {
            if (isSelf) {
              if (sysBloom.test(currentDomain) || sysBloom.testPipePipe(currentDomain)) {
                track('bloom_check');
                return pipelineResolver.block(request, query, context, settings, "BLOCK", `System List: ${currentDomain}`);
              }
              isSelf = false;
            } else {
              if (sysBloom.testPipePipe(currentDomain)) {
                track('bloom_check');
                return pipelineResolver.block(request, query, context, settings, "BLOCK", `System List: ||${currentDomain}`);
              }
            }
            const firstDot = currentDomain.indexOf('.');
            if (firstDot === -1) break;
            currentDomain = currentDomain.substring(firstDot + 1);
          }
        }
      }
    }

    // 4.2 Tầng 2: Custom Filter Lists (Từng bộ lọc riêng của người dùng)
    if (customEntries.length > 0) {
      for (const { id, entry } of customEntries) {
        const customFilter = entry.filter;
        if (customFilter && !customFilter.isEmpty()) {
          let currentDomain = domainLower;
          let isSelf = true;
          while (currentDomain) {
            if (isSelf) {
              if (customFilter.test(currentDomain) || customFilter.testPipePipe(currentDomain)) {
                track('bloom_check');
                return pipelineResolver.block(request, query, context, settings, "BLOCK", `Custom List #${id}: ${currentDomain}`);
              }
              isSelf = false;
            } else {
              if (customFilter.testPipePipe(currentDomain)) {
                track('bloom_check');
                return pipelineResolver.block(request, query, context, settings, "BLOCK", `Custom List #${id}: ||${currentDomain}`);
              }
            }
            const firstDot = currentDomain.indexOf('.');
            if (firstDot === -1) break;
            currentDomain = currentDomain.substring(firstDot + 1);
          }
        }
      }
    }

    // ── 阶段 5：外部列表正则与复杂通配符池 (Regex / Wildcard Pool) ─────────
    if (enabledSystemListIds && enabledSystemListIds.length > 0) {
      for (const sysId of enabledSystemListIds) {
        const sysAdguard = systemListsManager.getAdguard(sysId);
        if (sysAdguard?.matchPattern(domainLower)) {
          track('adguard_pattern');
          return pipelineResolver.block(request, query, context, settings, "BLOCK", "System List: Pattern");
        }
      }
    }
    if (customEntries.length > 0) {
      for (const { id, entry } of customEntries) {
        if (entry.engine?.matchPattern(domainLower)) {
          track('adguard_pattern');
          return pipelineResolver.block(request, query, context, settings, "BLOCK", `Custom List #${id}: Pattern`);
        }
      }
    }

    return null;
  }
};
