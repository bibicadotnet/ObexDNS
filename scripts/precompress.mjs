#!/usr/bin/env node
/**
 * @file precompress.mjs
 * @description Build-time pre-compression of the web dashboard (static/).
 *
 * For every compressible file this writes `<file>.br` (Brotli, max quality) and `<file>.gz` (gzip, level 9)
 * next to the original. The serverfull static handler (src/serverfull/http/assets.ts) serves these files
 * directly, so no compression ever happens while the server is running.
 *
 * Usage: node scripts/precompress.mjs [staticDir]   (default: ./static)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

// Keep in sync with COMPRESSIBLE_EXTS / MIN_COMPRESS_BYTES in src/serverfull/http/assets.ts.
// HTML is excluded on purpose: the worker rewrites it per request (CSP nonce + runtime config).
const EXTS = new Set(['.js', '.mjs', '.css', '.json', '.svg', '.wasm', '.webmanifest']);
const MIN_BYTES = 1024;
const CONCURRENCY = 4;

const root = path.resolve(process.argv[2] || 'static');

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

async function writeIfSmaller(target, data, rawSize) {
  if (data.length < rawSize) {
    await fs.writeFile(target, data);
    return data.length;
  }
  await fs.rm(target, { force: true });
  return 0;
}

async function compressFile(file) {
  const raw = await fs.readFile(file);
  const [br, gz] = await Promise.all([
    brotli(raw, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length
      }
    }),
    gzip(raw, { level: 9 })
  ]);
  const brSize = await writeIfSmaller(`${file}.br`, br, raw.length);
  await writeIfSmaller(`${file}.gz`, gz, raw.length);
  return { raw: raw.length, br: brSize };
}

async function main() {
  const files = [];
  for await (const f of walk(root)) {
    if (!EXTS.has(path.extname(f).toLowerCase())) continue;
    if ((await fs.stat(f)).size < MIN_BYTES) continue;
    files.push(f);
  }

  let totalRaw = 0;
  let totalBr = 0;
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const f = files[next++];
      const r = await compressFile(f);
      totalRaw += r.raw;
      totalBr += r.br || r.raw;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(
    `precompress: ${files.length} files, ${(totalRaw / 1024).toFixed(0)} KB -> ${(totalBr / 1024).toFixed(0)} KB (br)`
  );
}

main().catch((err) => {
  console.error('precompress failed:', err);
  process.exit(1);
});
