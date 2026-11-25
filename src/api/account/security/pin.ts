import { Env, User, ExecutionContext } from "../../../types";
import { UserModel } from "../../../models/user";
import { verifyUserReauth, ReauthPayload } from "./reauth";

/**
 * Handles security PIN management endpoints:
 * - POST /api/account/pin (verify identity and set client PIN hash)
 * - DELETE /api/account/pin (verify identity and remove PIN)
 *
 * @param request - Inbound HTTP Request.
 * @param env - Cloudflare Worker environment bindings.
 * @param user - Current authenticated user.
 * @param pathParts - URL pathname components.
 * @param ctx - Execution context.
 * @returns Response indicating operation outcome.
 */
export async function handlePinRequest(
  request: Request,
  env: Env,
  user: User,
  _pathParts: string[],
  _ctx: ExecutionContext
): Promise<Response> {
  const userModel = new UserModel(env.DB, env);
  const dbUser = await userModel.getById(user.id);
  if (!dbUser) return new Response("User not found", { status: 404 });

  const body = (await request.json()) as { pinHash?: string } & ReauthPayload;

  // 验证用户身份 (密码、Passkey 或 TOTP)
  const authResult = await verifyUserReauth(dbUser, body, env, request);
  if (!authResult.success) {
    return new Response(authResult.error || "Authentication failed", { status: 400 });
  }

  // POST /api/account/pin — 绑定/更新安全 PIN 码
  if (request.method === "POST") {
    const { pinHash } = body;
    // 验证 PIN 格式是否为 64 位十六进制哈希
    if (!pinHash || !/^[a-fA-F0-9]{64}$/.test(pinHash)) {
      return new Response("Invalid PIN hash format", { status: 400 });
    }

    // Store the client-side PIN hash directly to support challenge-response unlock verification
    await userModel.updatePinHash(user.id, pinHash);
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // DELETE /api/account/pin — 解绑安全 PIN 码
  if (request.method === "DELETE") {
    await userModel.updatePinHash(user.id, null);
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  return new Response("Method Not Allowed", { status: 405 });
}
