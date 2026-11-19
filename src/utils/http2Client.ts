/**
 * @file http2Client.ts
 * @description Native HTTP/2 client session pool for high-performance DoH queries (RFC 8484).
 * Supports connection multiplexing, automatic reconnects, and idle session cleanup.
 */

import type { ClientHttp2Session } from 'node:http2';
import { getAppUserAgent } from '../constants/version';

/**
 * Result returned by an HTTP/2 query.
 */
export interface Http2Response {
  /** HTTP response status code (e.g. 200). */
  status: number;
  /** Binary response payload (DNS wireformat). */
  answer: Uint8Array;
  /** Response headers. */
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Determines whether HTTP/2 is natively supported in the current runtime.
 * Evaluates Node.js runtime and ensures cloudflare:sockets / stub environments are safely bypassed.
 *
 * @returns boolean True if native node:http2 client is available.
 */
export function isHttp2Supported(): boolean {
  const isCloudflare =
    (typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers') ||
    typeof WebSocketPair !== 'undefined';
  const isNode = !isCloudflare && typeof process !== 'undefined' && !!process.versions?.node;
  return isNode;
}

/** Send a second copy of the query on a new session after this many ms without a response. */
export function getHedgeMs(): number {
  const n = typeof process !== 'undefined' ? Number(process.env?.DOH_H2_HEDGE_MS) : NaN;
  return Number.isFinite(n) && n >= 20 ? n : 100;
}

/**
 * Connection pool managing active ClientHttp2Session instances per origin.
 */
export class Http2SessionPool {
  private sessions = new Map<string, ClientHttp2Session>();
  /** Short-lived hedge sessions not (yet) promoted to the pool. */
  private candidates = new Map<string, { session: ClientHttp2Session; createdAt: number }>();
  private http2Module: typeof import('node:http2') | null = null;

  /**
   * Lazily loads the node:http2 module in Node.js environments.
   */
  private async getHttp2Module(): Promise<typeof import('node:http2')> {
    if (!this.http2Module) {
      this.http2Module = await import('node:http2');
    }
    return this.http2Module;
  }

  /** Opens a new session with the standard handlers. Does NOT put it in the pool. */
  private connect(origin: string, http2: typeof import('node:http2')): ClientHttp2Session {
    const session = http2.connect(origin);
    const evict = () => {
      if (this.sessions.get(origin) === session) this.sessions.delete(origin);
      if (this.candidates.get(origin)?.session === session) this.candidates.delete(origin);
    };
    session.on('error', evict);
    session.on('close', evict);
    // Unref socket so it does not prevent process termination
    if (typeof session.unref === 'function') {
      session.unref();
    }
    return session;
  }

  private isAlive(session: ClientHttp2Session): boolean {
    return !session.closed && !session.destroyed;
  }

  /**
   * Retrieves an active HTTP/2 session for the given origin or establishes a new one.
   *
   * @param origin - Target origin string (e.g. 'https://dns.quad9.net').
   * @returns Active ClientHttp2Session.
   */
  public async getSession(origin: string): Promise<ClientHttp2Session> {
    // Load the module BEFORE checking the pool: otherwise concurrent callers on an empty pool
    // all see "no session" across the await and each opens its own.
    const http2 = await this.getHttp2Module();
    const existing = this.sessions.get(origin);
    if (existing && this.isAlive(existing)) {
      return existing;
    }
    const session = this.connect(origin, http2);
    this.sessions.set(origin, session);
    return session;
  }

  /**
   * Session for the hedge copy. Never the session the original went on. Concurrent hedges
   * share one short-lived candidate so a burst does not open one connection per query.
   */
  private getHedgeSession(origin: string, avoid: ClientHttp2Session | null): ClientHttp2Session {
    const http2 = this.http2Module!;
    const cur = this.sessions.get(origin);
    if (cur && cur !== avoid && this.isAlive(cur)) return cur; // a sibling already replaced it

    const cand = this.candidates.get(origin);
    if (cand && this.isAlive(cand.session) && Date.now() - cand.createdAt < 1000) return cand.session;

    const session = this.connect(origin, http2);
    this.candidates.set(origin, { session, createdAt: Date.now() });
    // If it is not promoted to the pool, it must not linger.
    const t = setTimeout(() => {
      if (this.candidates.get(origin)?.session === session) this.candidates.delete(origin);
      if (this.sessions.get(origin) !== session) this.dropSession(origin, session);
    }, 2000);
    if (typeof (t as any).unref === 'function') (t as any).unref();
    return session;
  }

  /** The hedge answered first: its session becomes the pooled one, the silent one is dropped. */
  private promote(origin: string, session: ClientHttp2Session, old: ClientHttp2Session | null): void {
    const cur = this.sessions.get(origin);
    if (cur === session) return;
    if (cur && cur !== old) return; // a sibling already replaced it
    this.sessions.set(origin, session);
    if (this.candidates.get(origin)?.session === session) this.candidates.delete(origin);
    if (cur) this.dropSession(origin, cur);
  }

  /**
   * Sends a DNS query over HTTP/2 using RFC 8484 POST framing.
   *
   * Hedged: if no response arrives within HEDGE_MS, the same query is also sent on a NEW
   * session and the first answer wins (DNS queries are idempotent). Only if the new session
   * wins is the old one considered dead and replaced; if the old one answers, nothing changes.
   *
   * @param url - Parsed target DoH URL.
   * @param queryRaw - Wire-format DNS query packet.
   * @param timeoutMs - Overall timeout in milliseconds (default 5000).
   * @returns Promise resolving to the HTTP/2 response.
   */
  public async request(url: URL, queryRaw: Uint8Array, timeoutMs = 5000): Promise<Http2Response> {
    const http2 = await this.getHttp2Module();
    const origin = url.origin;

    return new Promise<Http2Response>((resolve, reject) => {
      let isSettled = false;
      let started = 0;
      let failed = 0;
      let lastErr: Error | null = null;
      let firstSession: ClientHttp2Session | null = null;
      const cancels: Array<() => void> = [];

      const overall = setTimeout(() => {
        finish(new Error(`HTTP/2 Request Timeout (${timeoutMs}ms)`));
      }, timeoutMs);
      const hedgeTimer = setTimeout(() => launch(true), getHedgeMs());

      const finish = (err: Error | null, res?: Http2Response) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(overall);
        clearTimeout(hedgeTimer);
        for (const c of cancels) c();
        cancels.length = 0;
        if (err) reject(err);
        else resolve(res!);
      };

      // An attempt failed. If it was the last one possible, fail; otherwise hedge right away.
      const onFail = (err: Error) => {
        lastErr = err;
        failed++;
        if (isSettled || failed < started) return; // another attempt is still running
        if (started < 2) launch(true);
        else finish(lastErr);
      };

      // Never let an exception escape as an unhandled rejection.
      const launch = (hedge: boolean) => {
        attempt(hedge).catch((e) => onFail(e instanceof Error ? e : new Error(String(e))));
      };

      const attempt = async (hedge: boolean) => {
        if (isSettled || started >= 2) return;
        started++;
        const session = hedge ? this.getHedgeSession(origin, firstSession) : await this.getSession(origin);
        if (!hedge) firstSession = session;
        if (isSettled) return;

        const req = session.request({
          [http2.constants.HTTP2_HEADER_METHOD]: 'POST',
          [http2.constants.HTTP2_HEADER_PATH]: url.pathname + url.search,
          [http2.constants.HTTP2_HEADER_SCHEME]: url.protocol.replace(':', ''),
          'accept': 'application/dns-message',
          'content-type': 'application/dns-message',
          'content-length': String(queryRaw.length),
          'user-agent': getAppUserAgent()
        });
        let cancelled = false;
        cancels.push(() => {
          cancelled = true;
          try {
            req.close(http2.constants.NGHTTP2_CANCEL);
          } catch { }
        });

        let status = 0;
        let gotResponse = false;
        const chunks: Buffer[] = [];
        let responseHeaders: Record<string, string | string[] | undefined> = {};

        req.on('response', (headers) => {
          gotResponse = true;
          status = Number(headers[http2.constants.HTTP2_HEADER_STATUS]) || 0;
          responseHeaders = headers;
        });
        req.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        req.on('end', () => {
          if (cancelled) return;
          // 'end' without a response means the stream was reset, not that we got an answer.
          if (!gotResponse) return onFail(new Error('HTTP/2 stream ended without response'));
          if (!isSettled && hedge) this.promote(origin, session, firstSession);
          const body = Buffer.concat(chunks);
          finish(null, {
            status,
            answer: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
            headers: responseHeaders
          });
        });
        req.on('error', (err: Error) => {
          if (cancelled) return; // we cancelled the loser ourselves: not a session problem
          if (this.sessions.get(origin) === session) this.dropSession(origin, session);
          onFail(err);
        });

        req.write(Buffer.from(queryRaw));
        req.end();
      };

      launch(false);
    });
  }

  /** Removes a session from the pool and closes it; force-destroys it if it never closes. */
  private dropSession(origin: string, session: ClientHttp2Session): void {
    if (this.sessions.get(origin) === session) this.sessions.delete(origin);
    try {
      session.close();
    } catch { }
    const t = setTimeout(() => {
      try {
        if (!session.destroyed) session.destroy();
      } catch { }
    }, 10_000);
    if (typeof (t as any).unref === 'function') (t as any).unref();
  }

  /**
   * Closes all active HTTP/2 sessions in the pool.
   */
  public closeAll(): void {
    for (const [origin, session] of this.sessions.entries()) {
      try {
        if (!session.closed && !session.destroyed) {
          session.close();
        }
      } catch { }
      this.sessions.delete(origin);
    }
    for (const [origin, cand] of this.candidates.entries()) {
      try {
        if (this.isAlive(cand.session)) cand.session.close();
      } catch { }
      this.candidates.delete(origin);
    }
  }
}

/**
 * Global shared HTTP/2 session pool singleton.
 */
export const http2SessionPool = new Http2SessionPool();