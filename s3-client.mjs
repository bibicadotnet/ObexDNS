#!/usr/bin/env node
/**
 * @file s3-client.mjs
 * @description Zero-dependency S3 / Cloudflare R2 client for ObexDNS backups (AWS SigV4).
 *
 * Design notes:
 * - Runs under Bun (container) and Node >= 22 (tests). Only node:* built-ins are used.
 * - Uploads and downloads are streamed from/to disk; a backup is never held in RAM.
 * - Uploads use UNSIGNED-PAYLOAD (valid over HTTPS for S3/R2) so the file is not read twice.
 * - Uploaded size is verified with HEAD after the PUT.
 * - Downloads for people go through presigned GET URLs, so the browser talks to R2 directly.
 *
 * CLI (all output is plain text; machine-readable commands print one JSON document on stdout):
 *   test
 *   list                                   -> JSON array [{ name, size, lastModified }]
 *   presign <name> [expiresSec]            -> presigned GET URL
 *   upload <localPath> <remoteName>
 *   download <remoteName> <localPath>      (exit 44 when the object does not exist)
 *   publish <localPath> <remoteName> <latestName> [keepDays]
 *                                          upload + refresh latest + prune
 *   prune [keepDays]
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const EXIT_NOT_FOUND = 44;
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/** Backup object names this tool creates / is allowed to expose and prune. */
export const BACKUP_NAME_RE = /^obexdns_backup_\d{8}_\d{6}\.tar\.(zst|gz)$/;
export const LATEST_NAME_RE = /^latest\.tar\.(zst|gz)$/;
export function isValidBackupObjectName(name) {
  return typeof name === 'string' && (BACKUP_NAME_RE.test(name) || LATEST_NAME_RE.test(name));
}

// ─── Config ──────────────────────────────────────────────────────────────────

function parseEnvFile(filePath) {
  const out = {};
  try {
    if (!fs.existsSync(filePath)) return out;
    for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
  } catch {
    /* unreadable env file: treat as empty */
  }
  return out;
}

/**
 * Resolves backup configuration. Precedence: process env > /data/config/.env > /data/.env.
 * `source` can be injected (tests); by default it is process.env plus the container env files.
 */
export function loadConfig(source) {
  const dataDir = process.env.OBEXDNS_DATA_DIR || '/data';
  // Lowest to highest precedence: runtime env file (written by entrypoint for cron jobs, which do not
  // inherit the container environment) < /data/.env < /data/config/.env. Process env always wins.
  const runtimeEnvFile = process.env.OBEXDNS_RUNTIME_ENV || '/etc/obexdns/backup.env';
  const files = source
    ? {}
    : {
        ...parseEnvFile(runtimeEnvFile),
        ...parseEnvFile(path.join(dataDir, '.env')),
        ...parseEnvFile(path.join(dataDir, 'config', '.env'))
      };
  const env = source || process.env;
  const get = (key, fallback = '') => env[key] || files[key] || fallback;
  /** Integer setting clamped to [min, max]; 0 is a valid value (never replaced by the default). */
  const int = (key, fallback, min, max) => {
    const n = parseInt(get(key), 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
  };

  const keepDaysRaw = parseInt(get('BACKUP_KEEP_DAYS', '30'), 10);
  return {
    endpoint: get('BACKUP_S3_ENDPOINT'),
    bucket: get('BACKUP_S3_BUCKET'),
    region: get('BACKUP_S3_REGION', 'auto'),
    accessKeyId: get('BACKUP_S3_ACCESS_KEY_ID', get('BACKUP_S3_ACCESS_KEY')),
    secretAccessKey: get('BACKUP_S3_SECRET_ACCESS_KEY', get('BACKUP_S3_SECRET_KEY')),
    prefix: get('BACKUP_S3_PREFIX', 'obexdns').replace(/^\/+|\/+$/g, ''),
    cron: get('BACKUP_CRON', get('BACKUP_CRON_EXPR', '0 2 * * *')),
    keepDays: Number.isFinite(keepDaysRaw) && keepDaysRaw > 0 ? keepDaysRaw : 30,
    // Job tuning (used by backup.mjs)
    dbPath: get('SERVERFULL_DB_PATH'),
    zstdLevel: int('BACKUP_ZSTD_LEVEL', 1, 1, 9),
    keepLocal: ['true', '1'].includes(get('BACKUP_KEEP_LOCAL').toLowerCase()),
    localDest: get('BACKUP_LOCAL_DEST'),
    yieldChunkKb: int('BACKUP_YIELD_CHUNK_KB', 512, 1, 65536),
    yieldSleepMs: int('BACKUP_YIELD_SLEEP_MS', 10, 0, 1000)
  };
}

export function missingConfig(cfg) {
  const missing = [];
  if (!cfg.endpoint) missing.push('BACKUP_S3_ENDPOINT');
  if (!cfg.bucket) missing.push('BACKUP_S3_BUCKET');
  if (!cfg.accessKeyId) missing.push('BACKUP_S3_ACCESS_KEY_ID');
  if (!cfg.secretAccessKey) missing.push('BACKUP_S3_SECRET_ACCESS_KEY');
  return missing;
}

function requireConfig(cfg) {
  const missing = missingConfig(cfg);
  if (missing.length) throw new Error(`Missing S3 configuration: ${missing.join(', ')}`);
}

// ─── SigV4 ───────────────────────────────────────────────────────────────────

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 3986 percent-encoding (also encodes ! ' ( ) *), as SigV4 requires. */
export function uriEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function encodeKeyPath(key) {
  return key.split('/').map(uriEncode).join('/');
}

function amzTimestamp(now) {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function signingKey(secret, dateStamp, region) {
  return hmac(hmac(hmac(hmac('AWS4' + secret, dateStamp), region), 's3'), 'aws4_request');
}

function canonicalQuery(params) {
  return params
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/**
 * Signs a request with the Authorization header.
 * Signed headers: host + every header in `extraHeaders` (names are lowercased) + x-amz-date + x-amz-content-sha256.
 * Headers that must not be signed (content-length, content-type) are simply not passed here.
 * Returns the headers to send (signed ones + authorization).
 */
export function signRequest(cfg, method, url, extraHeaders, payloadHash, now = new Date()) {
  const u = new URL(url);
  const amzDate = amzTimestamp(now);
  const dateStamp = amzDate.slice(0, 8);

  const headers = { host: u.host };
  for (const [k, v] of Object.entries(extraHeaders || {})) headers[k.toLowerCase()] = String(v).trim();
  headers['x-amz-date'] = amzDate;
  headers['x-amz-content-sha256'] = payloadHash;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    method.toUpperCase(),
    u.pathname,
    canonicalQuery([...u.searchParams.entries()]),
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = crypto
    .createHmac('sha256', signingKey(cfg.secretAccessKey, dateStamp, cfg.region))
    .update(stringToSign)
    .digest('hex');

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

/** Builds a presigned GET URL (query-string auth, only `host` is signed). */
export function presignUrl(cfg, url, { expiresSec = 300, now = new Date(), query = {} } = {}) {
  const u = new URL(url);
  const amzDate = amzTimestamp(now);
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;

  const params = [...u.searchParams.entries()];
  for (const [k, v] of Object.entries(query)) params.push([k, v]);
  params.push(
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${cfg.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresSec)],
    ['X-Amz-SignedHeaders', 'host']
  );
  const cq = canonicalQuery(params);
  const canonicalRequest = ['GET', u.pathname, cq, `host:${u.host}\n`, 'host', UNSIGNED_PAYLOAD].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = crypto
    .createHmac('sha256', signingKey(cfg.secretAccessKey, dateStamp, cfg.region))
    .update(stringToSign)
    .digest('hex');
  return `${u.origin}${u.pathname}?${cq}&X-Amz-Signature=${signature}`;
}

// ─── URL helpers ─────────────────────────────────────────────────────────────

function baseEndpoint(cfg) {
  let e = cfg.endpoint.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(e)) e = 'https://' + e;
  return e;
}

/** Path-style URL: <endpoint>/<bucket>/<key>. `key` is the full object key (prefix included). */
export function objectUrl(cfg, key = '') {
  const base = `${baseEndpoint(cfg)}/${uriEncode(cfg.bucket)}`;
  return key ? `${base}/${encodeKeyPath(key.replace(/^\/+/, ''))}` : base;
}

export function keyFor(cfg, name) {
  return cfg.prefix ? `${cfg.prefix}/${name}` : name;
}

// ─── HTTP transport (node:http(s): streams file bodies with a real Content-Length) ───

function httpRequest(method, url, headers, { body, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      u,
      { method, headers, agent: false },
      (res) => resolve(res)
    );
    // Idle timeout (no bytes in either direction), not a total deadline: large files may take long.
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`S3 request timed out after ${timeoutMs / 1000}s of inactivity`)));
    req.on('error', reject);
    if (body) {
      pipeline(body, req).catch(reject);
    } else {
      req.end();
    }
  });
}

async function readText(res) {
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks).toString('utf-8');
}

function describeError(status, text) {
  const code = /<Code>([^<]+)<\/Code>/i.exec(text)?.[1];
  const msg = /<Message>([^<]+)<\/Message>/i.exec(text)?.[1];
  if (code && msg) return `${code}: ${msg}`;
  if (code) return code;
  return `HTTP ${status}${text.trim() ? ' - ' + text.trim().slice(0, 150) : ''}`;
}

/** Signed small request (no body) returning { status, headers, text }. */
async function s3Call(cfg, method, url, extraHeaders = {}, now) {
  const headers = signRequest(cfg, method, url, extraHeaders, EMPTY_SHA256, now);
  const res = await httpRequest(method, url, headers);
  const text = await readText(res);
  return { status: res.statusCode || 0, headers: res.headers, text };
}

// ─── Operations ──────────────────────────────────────────────────────────────

export async function testConnection(cfg) {
  requireConfig(cfg);
  const url = `${objectUrl(cfg)}?list-type=2&max-keys=1`;
  const r = await s3Call(cfg, 'GET', url);
  if (r.status < 200 || r.status >= 300) throw new Error(describeError(r.status, r.text));
  return { success: true, message: `Successfully connected to S3 bucket '${cfg.bucket}'.` };
}

const decodeXml = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Lists every object under the configured prefix (handles pagination > 1000 keys). */
export async function listObjects(cfg) {
  requireConfig(cfg);
  const prefix = cfg.prefix ? `${cfg.prefix}/` : '';
  const out = [];
  let token = '';
  for (let page = 0; page < 1000; page++) {
    const q = new URLSearchParams({ 'list-type': '2', prefix });
    if (token) q.set('continuation-token', token);
    const r = await s3Call(cfg, 'GET', `${objectUrl(cfg)}?${q.toString()}`);
    if (r.status < 200 || r.status >= 300) throw new Error(`List failed: ${describeError(r.status, r.text)}`);

    for (const m of r.text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const block = m[1];
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1];
      const mod = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block)?.[1];
      const size = /<Size>(\d+)<\/Size>/.exec(block)?.[1];
      if (!key) continue;
      const fullKey = decodeXml(key);
      out.push({
        key: fullKey,
        name: prefix && fullKey.startsWith(prefix) ? fullKey.slice(prefix.length) : fullKey,
        size: size ? Number(size) : 0,
        lastModified: mod ? new Date(mod).getTime() : 0
      });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(r.text);
    const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(r.text)?.[1];
    if (!truncated || !next) break;
    token = decodeXml(next);
  }
  return out;
}

/** Backups only (timestamped + latest), newest first. Other objects under the prefix are ignored. */
export async function listBackups(cfg) {
  const all = await listObjects(cfg);
  return all
    .filter((o) => isValidBackupObjectName(o.name))
    .sort((a, b) => b.lastModified - a.lastModified || (a.name < b.name ? 1 : -1))
    .map(({ name, size, lastModified }) => ({ name, size, lastModified }));
}

export function presignDownload(cfg, name, expiresSec = 300) {
  requireConfig(cfg);
  if (!isValidBackupObjectName(name)) throw new Error('Invalid backup name');
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
  return presignUrl(cfg, objectUrl(cfg, keyFor(cfg, name)), {
    expiresSec,
    query: {
      'response-content-disposition': `attachment; filename="${safe}"`
    }
  });
}

export async function headObject(cfg, name) {
  const r = await s3Call(cfg, 'HEAD', objectUrl(cfg, keyFor(cfg, name)));
  if (r.status === 404) return null;
  if (r.status < 200 || r.status >= 300) throw new Error(`HEAD failed: HTTP ${r.status}`);
  return { size: Number(r.headers['content-length'] || 0) };
}

/** Streams a local file to <prefix>/<remoteName> and verifies the stored size afterwards. */
export async function uploadFile(cfg, localPath, remoteName, { onLog = console.log } = {}) {
  requireConfig(cfg);
  const stat = fs.statSync(localPath);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Local file missing or empty: ${localPath}`);

  const url = objectUrl(cfg, keyFor(cfg, remoteName));
  const headers = signRequest(cfg, 'PUT', url, {}, UNSIGNED_PAYLOAD);
  headers['content-length'] = String(stat.size);
  headers['content-type'] = 'application/octet-stream';

  onLog(`[S3-Backup] Uploading ${remoteName} (${(stat.size / 1024 / 1024).toFixed(2)} MB)...`);
  const res = await httpRequest('PUT', url, headers, { body: fs.createReadStream(localPath) });
  const text = await readText(res);
  if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
    throw new Error(`Upload failed: ${describeError(res.statusCode || 0, text)}`);
  }

  const head = await headObject(cfg, remoteName);
  if (!head || head.size !== stat.size) {
    throw new Error(`Upload verification failed for ${remoteName}: remote size ${head ? head.size : 'missing'} != local ${stat.size}`);
  }
  onLog(`[S3-Backup] Uploaded and verified: ${keyFor(cfg, remoteName)}`);
  return { size: stat.size };
}

/** Server-side copy within the bucket (no bytes pass through this machine). */
export async function copyObject(cfg, fromName, toName) {
  const source = `/${uriEncode(cfg.bucket)}/${encodeKeyPath(keyFor(cfg, fromName))}`;
  const r = await s3Call(cfg, 'PUT', objectUrl(cfg, keyFor(cfg, toName)), { 'x-amz-copy-source': source });
  if (r.status < 200 || r.status >= 300) throw new Error(`Copy failed: ${describeError(r.status, r.text)}`);
  // S3 may answer 200 with an <Error> body for copies.
  if (/<Error>/.test(r.text)) throw new Error(`Copy failed: ${describeError(r.status, r.text)}`);
}

export async function deleteObject(cfg, name) {
  const r = await s3Call(cfg, 'DELETE', objectUrl(cfg, keyFor(cfg, name)));
  if (!(r.status >= 200 && r.status < 300)) throw new Error(`Delete failed (${r.status})`);
}

/** Streams <prefix>/<remoteName> to localPath (written to a temp file, then renamed). Returns false on 404. */
export async function downloadFile(cfg, remoteName, localPath, { onLog = console.log } = {}) {
  requireConfig(cfg);
  const url = objectUrl(cfg, keyFor(cfg, remoteName));
  const headers = signRequest(cfg, 'GET', url, {}, EMPTY_SHA256);
  onLog(`[S3-Backup] Downloading ${keyFor(cfg, remoteName)}...`);
  const res = await httpRequest('GET', url, headers);
  const status = res.statusCode || 0;
  if (status === 404) {
    res.resume();
    return false;
  }
  if (status < 200 || status >= 300) {
    throw new Error(`Download failed: ${describeError(status, await readText(res))}`);
  }
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  const tmp = `${localPath}.part`;
  try {
    await pipeline(res, fs.createWriteStream(tmp));
    const expected = Number(res.headers['content-length'] || 0);
    const got = fs.statSync(tmp).size;
    if (expected && got !== expected) throw new Error(`Download truncated: ${got} of ${expected} bytes`);
    fs.renameSync(tmp, localPath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  onLog(`[S3-Backup] Downloaded ${(fs.statSync(localPath).size / 1024 / 1024).toFixed(2)} MB to ${localPath}`);
  return true;
}

/**
 * Deletes timestamped backups older than keepDays. Never touches latest.*, and always keeps the
 * `minKeep` newest backups even when they are older than the retention window.
 */
export async function pruneBackups(cfg, keepDays, { minKeep = 3, now = Date.now(), onLog = console.log } = {}) {
  requireConfig(cfg);
  const days = Number(keepDays);
  if (!Number.isFinite(days) || days <= 0) return 0;
  const all = (await listObjects(cfg))
    .filter((o) => BACKUP_NAME_RE.test(o.name))
    .sort((a, b) => b.lastModified - a.lastModified);
  const maxAgeMs = days * 86_400_000;
  let deleted = 0;
  for (const obj of all.slice(minKeep)) {
    const age = now - obj.lastModified;
    if (age <= maxAgeMs) continue;
    onLog(`[S3-Backup] Pruning expired backup: ${obj.name} (${(age / 86_400_000).toFixed(1)} days old)`);
    try {
      await deleteObject(cfg, obj.name);
      deleted++;
    } catch (err) {
      onLog(`[S3-Backup] Warning: ${err.message}`);
    }
  }
  onLog(`[S3-Backup] Retention finished. Pruned ${deleted} backup(s).`);
  return deleted;
}

/** Upload the timestamped archive, refresh the `latest` alias, then prune. */
export async function publishBackup(cfg, localPath, remoteName, latestName, keepDays, { onLog = console.log } = {}) {
  const { size } = await uploadFile(cfg, localPath, remoteName, { onLog });
  try {
    await copyObject(cfg, remoteName, latestName);
    onLog(`[S3-Backup] Updated ${latestName} (server-side copy).`);
  } catch (err) {
    onLog(`[S3-Backup] ${err.message}; re-uploading ${latestName}...`);
    await uploadFile(cfg, localPath, latestName, { onLog });
  }
  let pruned = 0;
  try {
    pruned = await pruneBackups(cfg, keepDays, { onLog });
  } catch (err) {
    onLog(`[S3-Backup] Warning: retention step failed: ${err.message}`);
  }
  return { size, pruned };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const [, , command, ...args] = process.argv;
  const cfg = loadConfig();
  try {
    switch (command) {
      case 'test':
        console.log(JSON.stringify(await testConnection(cfg)));
        break;
      case 'list':
        console.log(JSON.stringify(await listBackups(cfg)));
        break;
      case 'presign': {
        const [name, exp] = args;
        if (!name) throw new Error('Usage: s3-client.mjs presign <name> [expiresSec]');
        console.log(presignDownload(cfg, name, exp ? Math.min(Math.max(parseInt(exp, 10) || 300, 30), 3600) : 300));
        break;
      }
      case 'upload': {
        const [localPath, remoteName] = args;
        if (!localPath || !remoteName) throw new Error('Usage: s3-client.mjs upload <localPath> <remoteName>');
        await uploadFile(cfg, localPath, remoteName);
        break;
      }
      case 'download': {
        const [remoteName, localPath] = args;
        if (!remoteName || !localPath) throw new Error('Usage: s3-client.mjs download <remoteName> <localPath>');
        if (!(await downloadFile(cfg, remoteName, localPath))) {
          console.log(`[S3-Backup] '${keyFor(cfg, remoteName)}' not found in bucket '${cfg.bucket}' (404).`);
          process.exit(EXIT_NOT_FOUND);
        }
        break;
      }
      case 'publish': {
        const [localPath, remoteName, latestName, keepDays] = args;
        if (!localPath || !remoteName || !latestName) {
          throw new Error('Usage: s3-client.mjs publish <localPath> <remoteName> <latestName> [keepDays]');
        }
        await publishBackup(cfg, localPath, remoteName, latestName, keepDays || cfg.keepDays);
        break;
      }
      case 'prune':
        await pruneBackups(cfg, args[0] || cfg.keepDays);
        break;
      default:
        console.log('ObexDNS S3/R2 Backup Utility');
        console.log('Commands: test | list | presign <name> [sec] | upload <file> <name> | download <name> <file>');
        console.log('          publish <file> <name> <latestName> [keepDays] | prune [keepDays]');
    }
  } catch (err) {
    console.error('[S3-Backup] Fatal error:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// Run the CLI only when executed directly (not when imported by backup.mjs / tests).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error('[S3-Backup] Fatal error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
