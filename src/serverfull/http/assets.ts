/**
 * @file assets.ts
 * @description Static asset file serving and MIME mapping for Web Dashboard in Serverfull mode.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Env } from '../../types';
import { getPackageRoot } from '../config';

export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm'
};

/**
 * Extensions worth compressing. HTML is deliberately excluded: the worker rewrites it per request
 * (CSP nonce + runtime config), so it must reach the rewriter as plain bytes. Images are already compressed.
 */
const COMPRESSIBLE_EXTS = new Set(['.js', '.mjs', '.css', '.json', '.svg', '.wasm', '.webmanifest']);
const MIN_COMPRESS_BYTES = 1024;
const MAX_COMPRESS_CACHE_BYTES = 64 * 1024 * 1024;

interface CompressedEntry {
  mtimeMs: number;
  size: number;
  body: Promise<Buffer>;
  bytes: number;
}

const compressedCache = new Map<string, CompressedEntry>();
let compressedCacheBytes = 0;

/** Picks the best encoding the client accepts (br > gzip), or null for identity. */
function pickEncoding(acceptEncoding: string | null): 'br' | 'gzip' | null {
  if (!acceptEncoding) return null;
  const accepted = new Set<string>();
  for (const part of acceptEncoding.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    if (q && Number(q.slice(2)) === 0) continue;
    accepted.add(name.trim());
  }
  if (accepted.has('br')) return 'br';
  if (accepted.has('gzip')) return 'gzip';
  return null;
}

function compress(raw: Buffer, encoding: 'br' | 'gzip'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cb = (err: Error | null, out: Buffer) => (err ? reject(err) : resolve(out));
    if (encoding === 'br') {
      zlib.brotliCompress(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }, cb);
    } else {
      zlib.gzip(raw, { level: 9 }, cb);
    }
  });
}

/**
 * Returns the compressed bytes of a file. The cache is keyed by path + encoding and validated against the
 * file's mtime and size, so a redeployed file is recompressed automatically and an old copy is never served.
 * Compression runs on the libuv thread pool, so it does not block the event loop (DNS traffic).
 */
function getCompressed(filePath: string, encoding: 'br' | 'gzip', raw: Buffer, mtimeMs: number, size: number): Promise<Buffer> {
  const key = `${encoding}:${filePath}`;
  const hit = compressedCache.get(key);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.body;

  if (hit) {
    compressedCacheBytes -= hit.bytes;
    compressedCache.delete(key);
  }
  if (compressedCacheBytes > MAX_COMPRESS_CACHE_BYTES) {
    compressedCache.clear();
    compressedCacheBytes = 0;
  }

  const entry: CompressedEntry = { mtimeMs, size, bytes: size, body: compress(raw, encoding) };
  compressedCache.set(key, entry);
  compressedCacheBytes += entry.bytes;
  // A failed compression must not stay cached.
  entry.body.catch(() => {
    if (compressedCache.get(key) === entry) {
      compressedCache.delete(key);
      compressedCacheBytes -= entry.bytes;
    }
  });
  return entry.body;
}

/**
 * Attaches the static asset file-serving handler to the worker Env if not already attached.
 *
 * @param env - The Cloudflare/Serverfull Env object.
 * @param staticDir - Optional path to the directory containing static frontend files.
 */
export function attachStaticAssetHandler(env: Env, staticDir?: string): void {
  if (env.ASSETS) return;

  const targetDir = staticDir || path.join(getPackageRoot(), 'static');

  env.ASSETS = {
    fetch: async (req: Request): Promise<Response> => {
      try {
        const url = new URL(req.url);
        let pathname = decodeURIComponent(url.pathname);
        if (pathname === '/' || pathname === '') {
          pathname = '/index.html';
        }

        const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
        const filePath = path.join(targetDir, safePath);

        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath).toLowerCase();
          const contentType = MIME_TYPES[ext] || 'application/octet-stream';
          const stat = fs.statSync(filePath);
          const fileContent = fs.readFileSync(filePath);

          const headers: Record<string, string> = {
            'Content-Type': contentType,
            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'credentialless',
            'Cross-Origin-Resource-Policy': 'same-origin'
          };

          let body: Buffer = fileContent;
          if (COMPRESSIBLE_EXTS.has(ext) && fileContent.length >= MIN_COMPRESS_BYTES) {
            // Same URL can answer with or without compression, so caches must key on Accept-Encoding.
            headers['Vary'] = 'Accept-Encoding';
            const encoding = pickEncoding(req.headers.get('Accept-Encoding'));
            if (encoding) {
              try {
                const compressed = await getCompressed(filePath, encoding, fileContent, stat.mtimeMs, stat.size);
                if (compressed.length < fileContent.length) {
                  body = compressed;
                  headers['Content-Encoding'] = encoding;
                }
              } catch {
                // Fall back to the uncompressed file.
              }
            }
          }

          return new Response(body as unknown as BodyInit, { status: 200, headers });
        }

        return new Response('Not Found', { status: 404 });
      } catch {
        return new Response('Asset Error', { status: 500 });
      }
    }
  };
}
