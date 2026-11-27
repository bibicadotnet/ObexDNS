#!/usr/bin/env node
/**
 * @file s3-client.mjs
 * @description Lightweight zero-dependency S3/Cloudflare R2 client for ObexDNS backups.
 * Supports upload and retention pruning using standard AWS SigV4.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data, encoding) {
  return crypto.createHmac('sha256', key).update(data).digest(encoding);
}

function getSignatureKey(key, dateStamp, regionName, serviceName) {
  const kDate = hmac('AWS4' + key, dateStamp);
  const kRegion = hmac(kDate, regionName);
  const kService = hmac(kRegion, serviceName);
  const kSigning = hmac(kService, 'aws4_request');
  return kSigning;
}

function parseEnvFile(filePath) {
  const config = {};
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const k = trimmed.slice(0, eqIdx).trim();
          let v = trimmed.slice(eqIdx + 1).trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
          }
          config[k] = v;
        }
      }
    }
  } catch {}
  return config;
}

function getConfig() {
  const fileConfig = {
    ...parseEnvFile('/data/.env'),
    ...parseEnvFile('/data/config/.env')
  };

  const get = (key, fallback = '') => process.env[key] || fileConfig[key] || fallback;

  return {
    endpoint: get('BACKUP_S3_ENDPOINT'),
    bucket: get('BACKUP_S3_BUCKET'),
    region: get('BACKUP_S3_REGION', 'auto'),
    accessKeyId: get('BACKUP_S3_ACCESS_KEY_ID', get('BACKUP_S3_ACCESS_KEY')),
    secretAccessKey: get('BACKUP_S3_SECRET_ACCESS_KEY', get('BACKUP_S3_SECRET_KEY')),
    prefix: get('BACKUP_S3_PREFIX', 'obexdns').replace(/^\/+|\/+$/g, '')
  };
}

function signRequest({ method, url, region, accessKeyId, secretAccessKey, headers = {}, payloadHash }) {
  const parsedUrl = new URL(url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  headers['host'] = parsedUrl.host;
  headers['x-amz-date'] = amzDate;
  headers['x-amz-content-sha256'] = payloadHash;

  const sortedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaders.map(h => `${h.toLowerCase()}:${headers[h].trim()}\n`).join('');
  const signedHeaders = sortedHeaders.map(h => h.toLowerCase()).join(';');

  const searchParams = Array.from(parsedUrl.searchParams.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const canonicalQueryString = searchParams.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

  const canonicalRequest = [
    method.toUpperCase(),
    parsedUrl.pathname,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256(canonicalRequest)
  ].join('\n');

  const signingKey = getSignatureKey(secretAccessKey, dateStamp, region, 's3');
  const signature = hmac(signingKey, stringToSign, 'hex');

  headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return headers;
}

function buildS3Url(endpoint, bucket, keyPath = '') {
  let cleanEndpoint = endpoint.replace(/\/+$/, '');
  if (!cleanEndpoint.startsWith('http://') && !cleanEndpoint.startsWith('https://')) {
    cleanEndpoint = 'https://' + cleanEndpoint;
  }
  const cleanKey = keyPath.replace(/^\/+/, '');
  return `${cleanEndpoint}/${bucket}/${cleanKey}`;
}

async function uploadFile(localPath, remoteName) {
  const cfg = getConfig();
  if (!cfg.endpoint || !cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
    console.error('[S3-Backup] Error: S3 configuration missing (endpoint, bucket, accessKeyId, secretAccessKey required).');
    process.exit(1);
  }

  if (!fs.existsSync(localPath)) {
    console.error(`[S3-Backup] Error: Local file not found: ${localPath}`);
    process.exit(1);
  }

  const fileData = fs.readFileSync(localPath);
  const payloadHash = sha256(fileData);
  const remoteKey = cfg.prefix ? `${cfg.prefix}/${remoteName}` : remoteName;
  const targetUrl = buildS3Url(cfg.endpoint, cfg.bucket, remoteKey);

  const headers = {
    'content-type': 'application/gzip',
    'content-length': String(fileData.length)
  };

  signRequest({
    method: 'PUT',
    url: targetUrl,
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    headers,
    payloadHash
  });

  console.log(`[S3-Backup] Uploading ${remoteName} (${(fileData.length / 1024 / 1024).toFixed(2)} MB) to S3/R2...`);
  const resp = await fetch(targetUrl, {
    method: 'PUT',
    headers,
    body: fileData
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`[S3-Backup] Upload failed (${resp.status} ${resp.statusText}):`, errText);
    process.exit(1);
  }

  console.log(`[S3-Backup] Successfully uploaded: ${remoteKey}`);
}

async function pruneOldBackups(keepDays) {
  const cfg = getConfig();
  if (!cfg.endpoint || !cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
    return;
  }

  const days = parseInt(keepDays, 10);
  if (isNaN(days) || days <= 0) {
    return;
  }

  const listPrefix = cfg.prefix ? `${cfg.prefix}/` : '';
  const listUrl = buildS3Url(cfg.endpoint, cfg.bucket, '') + `?list-type=2&prefix=${encodeURIComponent(listPrefix)}`;
  const headers = {};

  signRequest({
    method: 'GET',
    url: listUrl,
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    headers,
    payloadHash: sha256('')
  });

  console.log(`[S3-Backup] Checking retention policy in bucket '${cfg.bucket}' (keeping ${days} days)...`);
  const resp = await fetch(listUrl, { method: 'GET', headers });
  if (!resp.ok) {
    console.warn(`[S3-Backup] Failed to list objects (${resp.status} ${resp.statusText})`);
    return;
  }

  const xml = await resp.text();
  const contentsRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match;
  const now = Date.now();
  const maxAgeMs = days * 86400 * 1000;
  let deletedCount = 0;

  while ((match = contentsRegex.exec(xml)) !== null) {
    const block = match[1];
    const keyMatch = /<Key>(.*?)<\/Key>/.exec(block);
    const modMatch = /<LastModified>(.*?)<\/LastModified>/.exec(block);

    if (keyMatch && modMatch) {
      const key = keyMatch[1];
      const modDate = new Date(modMatch[1]).getTime();

      // Don't delete latest.tar.gz or latest.zip
      if (key.endsWith('latest.tar.gz') || key.endsWith('latest.zip')) {
        continue;
      }

      // Check if age exceeds retention days
      const ageMs = now - modDate;
      if (ageMs > maxAgeMs) {
        console.log(`[S3-Backup] Pruning expired backup: ${key} (age: ${(ageMs / 86400000).toFixed(1)} days)...`);
        const delUrl = buildS3Url(cfg.endpoint, cfg.bucket, key);
        const delHeaders = {};
        signRequest({
          method: 'DELETE',
          url: delUrl,
          region: cfg.region,
          accessKeyId: cfg.accessKeyId,
          secretAccessKey: cfg.secretAccessKey,
          headers: delHeaders,
          payloadHash: sha256('')
        });

        const delResp = await fetch(delUrl, { method: 'DELETE', headers: delHeaders });
        if (delResp.ok || delResp.status === 204) {
          deletedCount++;
        } else {
          console.warn(`[S3-Backup] Failed to delete ${key} (${delResp.status})`);
        }
      }
    }
  }

  console.log(`[S3-Backup] Retention cleanup finished. Pruned ${deletedCount} expired backup(s).`);
}

async function downloadFile(remoteName, localPath) {
  const cfg = getConfig();
  if (!cfg.endpoint || !cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
    console.error('[S3-Backup] Error: S3 configuration missing (endpoint, bucket, accessKeyId, secretAccessKey required).');
    process.exit(1);
  }

  const remoteKey = cfg.prefix ? `${cfg.prefix}/${remoteName}` : remoteName;
  const targetUrl = buildS3Url(cfg.endpoint, cfg.bucket, remoteKey);

  const headers = {};
  signRequest({
    method: 'GET',
    url: targetUrl,
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    headers,
    payloadHash: sha256('')
  });

  console.log(`[S3-Backup] Downloading ${remoteKey} from S3/Cloudflare R2...`);
  const resp = await fetch(targetUrl, { method: 'GET', headers });

  if (resp.status === 404) {
    console.log(`[S3-Backup] File '${remoteKey}' not found in bucket '${cfg.bucket}' (404).`);
    process.exit(44);
  }

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`[S3-Backup] Download failed (${resp.status} ${resp.statusText}):`, errText);
    process.exit(1);
  }

  const arrayBuffer = await resp.arrayBuffer();
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, Buffer.from(arrayBuffer));
  console.log(`[S3-Backup] Successfully downloaded ${remoteKey} (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB) to ${localPath}`);
}

async function main() {
  const [,, command, ...args] = process.argv;

  try {
    if (command === 'upload') {
      const [localPath, remoteName] = args;
      if (!localPath || !remoteName) {
        console.error('Usage: s3-client.mjs upload <localPath> <remoteName>');
        process.exit(1);
      }
      await uploadFile(localPath, remoteName);
    } else if (command === 'download') {
      const [remoteName, localPath] = args;
      if (!remoteName || !localPath) {
        console.error('Usage: s3-client.mjs download <remoteName> <localPath>');
        process.exit(1);
      }
      await downloadFile(remoteName, localPath);
    } else if (command === 'prune') {
      const [keepDays] = args;
      await pruneOldBackups(keepDays || '30');
    } else {
      console.log('ObexDNS S3/R2 Backup Utility');
      console.log('Commands:');
      console.log('  upload <localPath> <remoteName>');
      console.log('  download <remoteName> <localPath>');
      console.log('  prune <keepDays>');
    }
  } catch (err) {
    console.error('[S3-Backup] Fatal error:', err);
    process.exit(1);
  }
}

main();
