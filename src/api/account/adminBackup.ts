/**
 * @file adminBackup.ts
 * @description /api/admin/backup/* (Serverfull / Docker only).
 *
 * The heavy work lives in /app/backup.mjs and /app/s3-client.mjs, which run as separate processes so they
 * never block the DNS / DoH event loop:
 *   GET  /backup            config + job status (polled by the UI while a backup runs)
 *   POST /backup/test       test S3 credentials
 *   POST /backup/run        start a background backup -> 202 (409 if one is already running)
 *   GET  /backup/list       backups stored in the bucket
 *   POST /backup/presign    { name } -> short-lived presigned GET URL; the browser downloads from R2/S3 directly
 */

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

/** Same allowlist as s3-client.mjs: only backups created by this tool can be presigned. */
const BACKUP_OBJECT_RE = /^(obexdns_backup_\d{8}_\d{6}|latest)\.tar\.(zst|gz)$/;
const PRESIGN_TTL_SEC = 300;
const EXIT_BUSY = 75;

interface JobStatus {
  state: 'running' | 'success' | 'failed';
  trigger?: string;
  phase?: string;
  pid?: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  error?: string;
  file?: string;
  sizeBytes?: number;
  uploaded?: boolean;
  lastSuccess?: { file: string; sizeBytes: number; finishedAt: number; uploaded?: boolean } | null;
}

export async function handleBackupRequest(request: Request, pathParts: string[]): Promise<Response> {
  const nodeFs = await import('node:fs');
  const nodePath = await import('node:path');
  const nodeCp = await import('node:child_process');

  const dataDir = process.env.OBEXDNS_DATA_DIR || '/data';
  const appDir = process.env.OBEXDNS_APP_DIR || '/app';
  const s3Script = nodePath.join(appDir, 's3-client.mjs');
  const backupScript = nodePath.join(appDir, 'backup.mjs');
  const statusFile = nodePath.join(dataDir, '.backup_status.json');
  const runtime = process.execPath || 'bun';

  // ── Configuration (process env > /data/config/.env > /data/.env), same precedence as the scripts ──
  const parseEnvFile = (filePath: string) => {
    const cfg: Record<string, string> = {};
    try {
      if (!nodeFs.existsSync(filePath)) return cfg;
      for (const line of nodeFs.readFileSync(filePath, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        let v = trimmed.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        cfg[trimmed.slice(0, eq).trim()] = v;
      }
    } catch {
      /* unreadable: ignore */
    }
    return cfg;
  };
  const fileConfig = {
    ...parseEnvFile(nodePath.join(dataDir, '.env')),
    ...parseEnvFile(nodePath.join(dataDir, 'config', '.env'))
  };
  const getVal = (key: string, fallback = '') => process.env[key] || fileConfig[key] || fallback;

  const endpoint = getVal('BACKUP_S3_ENDPOINT');
  const bucket = getVal('BACKUP_S3_BUCKET');
  const accessKeyId = getVal('BACKUP_S3_ACCESS_KEY_ID', getVal('BACKUP_S3_ACCESS_KEY'));
  const secretAccessKey = getVal('BACKUP_S3_SECRET_ACCESS_KEY', getVal('BACKUP_S3_SECRET_KEY'));
  const isConfigured = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);

  // ── Job status helpers ──
  const pidAlive = (pid?: number) => {
    if (!pid || !Number.isInteger(pid)) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e: any) {
      return e?.code === 'EPERM';
    }
  };

  const readStatus = (): JobStatus | null => {
    try {
      return JSON.parse(nodeFs.readFileSync(statusFile, 'utf-8')) as JobStatus;
    } catch {
      return null;
    }
  };

  const writeStatus = (status: JobStatus) => {
    const tmp = `${statusFile}.api.tmp`;
    try {
      nodeFs.writeFileSync(tmp, JSON.stringify(status));
      nodeFs.renameSync(tmp, statusFile);
    } catch {
      /* best effort */
    }
  };

  /** Status as shown to the UI. A "running" job whose process is gone was killed (restart, OOM). */
  const currentStatus = (): (JobStatus & { running: boolean }) | null => {
    const s = readStatus();
    if (!s) return null;
    if (s.state === 'running') {
      if (pidAlive(s.pid)) return { ...s, running: true };
      return { ...s, state: 'failed', error: s.error || 'Backup was interrupted (process ended unexpectedly)', running: false };
    }
    return { ...s, running: false };
  };

  const execCli = (args: string[], timeoutMs: number) =>
    new Promise<{ ok: boolean; out: string; err: string }>((resolve) => {
      nodeCp.execFile(runtime, [s3Script, ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ ok: !error, out: String(stdout || '').trim(), err: (String(stderr || '').trim() || String(stdout || '').trim() || error?.message || '').replace(/^\[S3-Backup\]\s*(Fatal error:\s*)?/, '') });
      });
    });

  const sub = pathParts[3];

  // GET /api/admin/backup -> configuration + job status
  if (request.method === 'GET' && !sub) {
    return json({
      configured: isConfigured,
      endpoint: endpoint || null,
      bucket: bucket || null,
      region: getVal('BACKUP_S3_REGION', 'auto'),
      prefix: getVal('BACKUP_S3_PREFIX', 'obexdns').replace(/^\/+|\/+$/g, ''),
      cron: getVal('BACKUP_CRON', getVal('BACKUP_CRON_EXPR', '0 2 * * *')),
      keepDays: parseInt(getVal('BACKUP_KEEP_DAYS', '30'), 10) || 30,
      job: currentStatus()
    });
  }

  if (!isConfigured && sub) {
    return json({ success: false, error: 'S3 backup is not configured (missing endpoint, bucket, or credentials).' }, 400);
  }

  // POST /api/admin/backup/test
  if (request.method === 'POST' && sub === 'test') {
    if (!nodeFs.existsSync(s3Script)) return json({ success: false, error: 's3-client.mjs not found.' }, 500);
    const r = await execCli(['test'], 15_000);
    if (!r.ok) return json({ success: false, error: r.err }, 400);
    try {
      return json(JSON.parse(r.out));
    } catch {
      return json({ success: true, message: `Connected to S3 bucket '${bucket}' successfully.` });
    }
  }

  // POST /api/admin/backup/run -> start a background job and return immediately
  if (request.method === 'POST' && sub === 'run') {
    if (!nodeFs.existsSync(backupScript)) return json({ success: false, error: 'backup.mjs not found.' }, 500);

    const before = currentStatus();
    if (before?.running) {
      return json({ success: false, running: true, error: 'A backup is already running.' }, 409);
    }

    // Container logs get the job output, like the cron-started runs.
    let out: number | 'ignore' = 'ignore';
    try {
      out = nodeFs.openSync('/proc/1/fd/1', 'a');
    } catch {
      /* not available (non-container): discard output */
    }

    const child = nodeCp.spawn(runtime, [backupScript, '--trigger', 'manual'], {
      detached: true,
      stdio: ['ignore', out, out]
    });
    if (typeof out === 'number') nodeFs.closeSync(out);

    // Show "running" immediately so the first poll never sees the previous run's result.
    const previous = readStatus();
    writeStatus({
      state: 'running',
      trigger: 'manual',
      phase: 'starting',
      pid: child.pid,
      startedAt: Date.now(),
      lastSuccess: previous?.lastSuccess ?? null
    });

    child.on('error', (err) => {
      writeStatus({
        state: 'failed',
        trigger: 'manual',
        finishedAt: Date.now(),
        error: `Could not start backup: ${err.message}`,
        lastSuccess: previous?.lastSuccess ?? null
      });
    });
    child.on('exit', (code) => {
      // Lost the race against a cron run: it owns the status file, put back what it had.
      if (code === EXIT_BUSY && previous) writeStatus(previous);
    });
    child.unref();

    return json({ success: true, started: true, message: 'Backup started.' }, 202);
  }

  // GET /api/admin/backup/list -> backups in the bucket (newest first)
  if (request.method === 'GET' && sub === 'list') {
    const r = await execCli(['list'], 30_000);
    if (!r.ok) return json({ success: false, error: r.err }, 502);
    try {
      return json({ success: true, backups: JSON.parse(r.out) });
    } catch {
      return json({ success: false, error: 'Unexpected response while listing backups.' }, 502);
    }
  }

  // POST /api/admin/backup/presign { name } -> short-lived direct download URL
  if (request.method === 'POST' && sub === 'presign') {
    let name = '';
    try {
      name = String(((await request.json()) as { name?: unknown })?.name ?? '');
    } catch {
      /* fall through to validation */
    }
    if (!BACKUP_OBJECT_RE.test(name)) return json({ success: false, error: 'Invalid backup name.' }, 400);

    const r = await execCli(['presign', name, String(PRESIGN_TTL_SEC)], 10_000);
    if (!r.ok || !/^https?:\/\//.test(r.out)) return json({ success: false, error: r.err || 'Could not create download link.' }, 500);
    return json({ success: true, url: r.out, name, expiresIn: PRESIGN_TTL_SEC });
  }

  return new Response('Not Found', { status: 404 });
}
