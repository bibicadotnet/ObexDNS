import { Env, User, ExecutionContext, Rule } from "../../types";
import { RuleModel } from "../../models/rule";
import { pipeline } from "../../pipeline";
import { DNSFilter } from "../../lib/filtering";

/**
 * Handle custom rules requests to /api/profiles/:id/rules
 */
export async function handleProfileRulesRequest(
  request: Request,
  env: Env,
  user: User,
  profileId: string,
  pathParts: string[],
  ctx: ExecutionContext
): Promise<Response> {
  const ruleModel = new RuleModel(env.DB);

  if (request.method === 'GET') {
    const results = await ruleModel.getRules(profileId);
    const mapped = results.map(r => ({
      ...r,
      enabled: r.enabled === undefined || r.enabled === null ? true : (r.enabled !== 0 && (r.enabled as any) !== false)
    }));
    return new Response(JSON.stringify(mapped), { headers: { 'Content-Type': 'application/json' } });
  }

  if (request.method === 'PATCH') {
    let ruleId = Number(pathParts[4]);
    let body: { id?: unknown; enabled?: unknown };
    try {
      body = await request.json() as { id?: unknown; enabled?: unknown };
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }

    if (!ruleId && Number.isInteger(Number(body?.id))) {
      ruleId = Number(body.id);
    }

    if (!Number.isInteger(ruleId) || ruleId <= 0) {
      return new Response("Invalid rule id", { status: 400 });
    }

    if (typeof body.enabled !== 'boolean') {
      return new Response("Body must contain { enabled: boolean }", { status: 400 });
    }

    const rule = await ruleModel.getRuleById(ruleId, profileId);
    if (!rule) {
      return new Response("Rule Not Found", { status: 404 });
    }

    const updated = await ruleModel.setEnabled(ruleId, profileId, body.enabled);
    if (!updated) {
      return new Response("Failed to update rule", { status: 500 });
    }

    ctx.waitUntil(pipeline.clearCache(profileId, false, env));
    return new Response(JSON.stringify({ id: ruleId, enabled: body.enabled }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (request.method === 'POST') {
    const body = await request.json() as any;

    // Support bulk insertion when body is an array or contains rules array
    const isBulk = Array.isArray(body) || (body && Array.isArray(body.rules));
    if (isBulk) {
      const rawList: any[] = Array.isArray(body) ? body : body.rules;
      const seen = new Set<string>();
      const validRules: Partial<Rule>[] = [];

      for (const r of rawList) {
        if (!r || typeof r.pattern !== 'string') continue;
        const pattern = DNSFilter.normalizePattern(r.pattern);
        if (!pattern || DNSFilter.validatePattern(pattern)) continue;
        const key = pattern.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        const type = String(r.type || 'BLOCK').toUpperCase();
        if (type !== 'ALLOW' && type !== 'BLOCK' && type !== 'REDIRECT') continue;

        validRules.push({
          type: type as 'ALLOW' | 'BLOCK' | 'REDIRECT',
          pattern,
          v_a: r.v_a || null,
          v_aaaa: r.v_aaaa || null,
          v_txt: r.v_txt || null,
          v_cname: r.v_cname || null,
          created_at: typeof r.created_at === 'number' ? r.created_at : undefined,
          include_subdomains: Boolean(r.include_subdomains),
          enabled: r.enabled !== undefined ? (r.enabled ? 1 : 0) : 1,
        });
      }

      if (validRules.length === 0) {
        return new Response(JSON.stringify({ count: 0, message: "No valid rules provided" }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const existingRules = await ruleModel.getRules(profileId);
      const existingPatterns = new Set(existingRules.map(r => r.pattern.trim().toLowerCase()));
      const rulesToInsert = validRules.filter(r => !existingPatterns.has(r.pattern!.toLowerCase()));

      let insertedCount = 0;
      if (rulesToInsert.length > 0) {
        insertedCount = await ruleModel.addRulesBulk(profileId, rulesToInsert);
        ctx.waitUntil(pipeline.clearCache(profileId, false, env));
      }

      return new Response(JSON.stringify({ success: true, count: insertedCount }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const rule = body;
    const pattern = rule.pattern ? rule.pattern.trim() : "";
    if (!pattern) {
      return new Response("Domain pattern cannot be empty", { status: 400 });
    }
    const patternError = DNSFilter.validatePattern(pattern);
    if (patternError) {
      return new Response(patternError, { status: 400 });
    }
    const existing = await ruleModel.getRuleByPattern(profileId, pattern);
    if (existing) {
      return new Response("Rule for this domain already exists", { status: 400 });
    }
    rule.include_subdomains = Boolean(rule.include_subdomains);
    if (rule.enabled !== undefined) {
      rule.enabled = Boolean(rule.enabled);
    }
    await ruleModel.addRule(profileId, rule);
    ctx.waitUntil(pipeline.clearCache(profileId, false, env));
    return new Response(null, { status: 201 });
  }

  if (request.method === 'PUT') {
    const rule = await request.json() as any;
    const pattern = rule.pattern ? rule.pattern.trim() : "";
    if (!pattern) {
      return new Response("Domain pattern cannot be empty", { status: 400 });
    }
    const patternError = DNSFilter.validatePattern(pattern);
    if (patternError) {
      return new Response(patternError, { status: 400 });
    }
    const existing = await ruleModel.getRuleByPatternExcludeId(profileId, pattern, rule.id);
    if (existing) {
      return new Response("Rule for this domain already exists", { status: 400 });
    }
    rule.include_subdomains = Boolean(rule.include_subdomains);
    if (rule.enabled !== undefined) {
      rule.enabled = Boolean(rule.enabled);
    }
    await ruleModel.updateRule(rule.id, profileId, rule);
    ctx.waitUntil(pipeline.clearCache(profileId, false, env));
    return new Response(null, { status: 200 });
  }

  if (request.method === 'DELETE') {
    const { id } = await request.json() as any;
    await ruleModel.deleteRule(id, profileId);
    ctx.waitUntil(pipeline.clearCache(profileId, false, env));
    return new Response(null, { status: 204 });
  }

  return new Response("Method Not Allowed", { status: 405 });
}
