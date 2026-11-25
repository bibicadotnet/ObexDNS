/**
 * @file assets.ts
 * @description Static asset file serving and MIME mapping for Web Dashboard in Serverfull mode.
 *
 * Performance notes:
 * - All file I/O is asynchronous (fs.promises), so serving the dashboard never blocks the event loop that
 *   also handles DNS (UDP/DoT/DoH) traffic.
 * - Compression is NOT done at runtime. `scripts/precompress.mjs` (run by `build:serverfull`) writes
 *   `<file>.br` / `<file>.gz` next to each compressible file at build time; this handler only picks the
 *   right variant. If no pre-compressed variant exists the plain file is served.
 * - Recently served files are kept in a small in-memory cache validated against mtime/size.
 */

import fs from 'node:fs';
import path from 'node:path';
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
 * Extensions that have pre-compressed variants (keep in sync with scripts/precompress.mjs).
 * HTML is deliberately excluded: the worker rewrites it per request (CSP nonce + runtime config),
 * so it must reach the rewriter as plain bytes. Images are already compressed.
 */
const COMPRESSIBLE_EXTS = new Set(['.js', '.mjs', '.css', '.json', '.svg', '.wasm', '.webmanifest']);
const MIN_COMPRESS_BYTES = 1024;
const MAX_FILE_CACHE_BYTES = 64 * 1024 * 1024;

type Encoding = 'br' | 'gzip';
const ENCODING_SUFFIX: Record<Encoding, string> = { br: '.br', gzip: '.gz' };

interface FileEntry {
  mtimeMs: number;
  size: number;
  body: Buffer;
}

const fileCache = new Map<string, FileEntry>();
let fileCacheBytes = 0;

/** Returns the encodings the client accepts, best first (br > gzip). Empty means identity only. */
function acceptedEncodings(acceptEncoding: string | null): Encoding[] {
  if (!acceptEncoding) return [];
  const accepted = new Set<string>();
  for (const part of acceptEncoding.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    if (q && Number(q.slice(2)) === 0) continue;
    accepted.add(name.trim());
  }
  const out: Encoding[] = [];
  if (accepted.has('br')) out.push('br');
  if (accepted.has('gzip')) out.push('gzip');
  return out;
}

/** Async stat that resolves to the Stats of a regular file, or null if missing / not a file. */
async function statFile(filePath: string): Promise<fs.Stats | null> {
  try {
    const st = await fs.promises.stat(filePath);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

/** Reads a file through the in-memory cache; entries are revalidated by mtime and size on every call. */
async function readCached(filePath: string, st: fs.Stats): Promise<Buffer> {
  const hit = fileCache.get(filePath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.body;

  const body = await fs.promises.readFile(filePath);

  if (hit) {
    fileCacheBytes -= hit.body.length;
    fileCache.delete(filePath);
  }
  if (body.length <= MAX_FILE_CACHE_BYTES) {
    if (fileCacheBytes + body.length > MAX_FILE_CACHE_BYTES) {
      fileCache.clear();
      fileCacheBytes = 0;
    }
    fileCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, body });
    fileCacheBytes += body.length;
  }
  return body;
}

/**
 * Attaches the static asset file-serving handler to the worker Env if not already attached.
 *
 * @param env - The Cloudflare/Serverfull Env object.
 * @param staticDir - Optional path to the directory containing static frontend files.
 */
export function attachStaticAssetHandler(env: Env, staticDir?: string): void {
  if (env.ASSETS) return;

  const targetDir = path.resolve(staticDir || path.join(getPackageRoot(), 'static'));

  env.ASSETS = {
    fetch: async (req: Request): Promise<Response> => {
      try {
        const url = new URL(req.url);
        let pathname: string;
        try {
          pathname = decodeURIComponent(url.pathname);
        } catch {
          return new Response('Bad Request', { status: 400 });
        }
        if (pathname.includes('\0')) {
          return new Response('Bad Request', { status: 400 });
        }
        if (pathname === '/' || pathname === '') {
          pathname = '/index.html';
        }

        const filePath = path.join(targetDir, path.normalize(pathname));
        // Never serve anything outside the static directory.
        if (filePath !== targetDir && !filePath.startsWith(targetDir + path.sep)) {
          return new Response('Not Found', { status: 404 });
        }

        const stat = await statFile(filePath);
        if (!stat) {
          return new Response('Not Found', { status: 404 });
        }

        const ext = path.extname(filePath).toLowerCase();
        const headers: Record<string, string> = {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'credentialless',
          'Cross-Origin-Resource-Policy': 'same-origin'
        };

        if (COMPRESSIBLE_EXTS.has(ext) && stat.size >= MIN_COMPRESS_BYTES) {
          // Same URL can answer with or without compression, so caches must key on Accept-Encoding.
          headers['Vary'] = 'Accept-Encoding';
          for (const encoding of acceptedEncodings(req.headers.get('Accept-Encoding'))) {
            const variantPath = filePath + ENCODING_SUFFIX[encoding];
            const variantStat = await statFile(variantPath);
            // Ignore a variant older than the file it belongs to (stale after a redeploy).
            if (!variantStat || variantStat.mtimeMs < stat.mtimeMs) continue;
            const body = await readCached(variantPath, variantStat);
            headers['Content-Encoding'] = encoding;
            return new Response(body as unknown as BodyInit, { status: 200, headers });
          }
        }

        const body = await readCached(filePath, stat);
        return new Response(body as unknown as BodyInit, { status: 200, headers });
      } catch {
        return new Response('Asset Error', { status: 500 });
      }
    }
  };
}
