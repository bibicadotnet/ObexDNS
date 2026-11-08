/**
 * @file cache.ts
 * @description In-memory Cache API and HTMLRewriter polyfill for Node.js runtime.
 */

export class MemoryCache {
  private store = new Map<string, { body: Uint8Array; headers: Headers; status: number; statusText: string; expires: number }>();
  private readonly maxEntries: number;

  constructor(maxEntries = 5000) {
    this.maxEntries = maxEntries;
  }

  async match(request: string | Request): Promise<Response | undefined> {
    const url = typeof request === 'string' ? request : request.url;
    const entry = this.store.get(url);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.store.delete(url);
      return undefined;
    }
    // 更新 LRU 访问次序
    this.store.delete(url);
    this.store.set(url, entry);

    return new Response(entry.body, {
      status: entry.status,
      statusText: entry.statusText,
      headers: new Headers(entry.headers)
    });
  }

  async put(request: string | Request, response: Response): Promise<void> {
    const url = typeof request === 'string' ? request : request.url;
    const cc = response.headers.get('Cache-Control') || '';
    const maxAgeMatch = cc.match(/max-age=(\d+)/i);
    const ttl = maxAgeMatch ? parseInt(maxAgeMatch[1], 10) : 3600;
    const bodyBuf = await response.clone().arrayBuffer();
    const now = Date.now();

    // 容量受限防御：超出上限时先惰性清理过期项，仍超限则按 LRU 淘汰最旧项
    if (!this.store.has(url) && this.store.size >= this.maxEntries) {
      for (const [k, v] of this.store) {
        if (now > v.expires) {
          this.store.delete(k);
        }
      }

      while (this.store.size >= this.maxEntries) {
        const oldestKey = this.store.keys().next().value;
        if (oldestKey === undefined) break;
        this.store.delete(oldestKey);
      }
    }

    this.store.delete(url);
    this.store.set(url, {
      body: new Uint8Array(bodyBuf),
      headers: new Headers(response.headers),
      status: response.status,
      statusText: response.statusText,
      expires: now + ttl * 1000
    });
  }

  async delete(request: string | Request): Promise<boolean> {
    const url = typeof request === 'string' ? request : request.url;
    return this.store.delete(url);
  }
}

/**
 * Ensures global Cache API and HTMLRewriter are initialized in Node.js.
 */
export function initNodeGlobals(): void {
  if (typeof (globalThis as any).caches === 'undefined') {
    const defaultCache = new MemoryCache();
    (globalThis as any).caches = {
      default: defaultCache,
      open: async () => new MemoryCache()
    };
  }

  if (typeof (globalThis as any).HTMLRewriter === 'undefined') {
    (globalThis as any).HTMLRewriter = class {
      private handlers: Array<{ selector: string; fn: (el: any) => void }> = [];

      on(selector: string, handler: { element?: (el: any) => void }) {
        if (handler.element) {
          this.handlers.push({ selector, fn: handler.element });
        }
        return this;
      }

      transform(response: Response): Response {
        const handlers = this.handlers;
        const originalTextPromise = response.text();

        const stream = new ReadableStream({
          async start(controller) {
            let html = await originalTextPromise;
            for (const h of handlers) {
              if (h.selector === 'head') {
                h.fn({
                  prepend(content: string) {
                    html = html.replace(/<head[^>]*>/i, `$&${content}`);
                  },
                  append(content: string) {
                    html = html.replace(/<\/head>/i, `${content}$&`);
                  }
                });
              }
            }
            controller.enqueue(new TextEncoder().encode(html));
            controller.close();
          }
        });

        const newHeaders = new Headers(response.headers);
        newHeaders.delete('content-length');

        return new Response(stream, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
        });
      }
    };
  }
}
