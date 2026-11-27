import type { UserInfo } from "./types";

export interface CreateUserPayload {
  username: string;
  password?: string;
  role?: "admin" | "user";
}

export async function getUsers(): Promise<UserInfo[]> {
  const res = await fetch("/api/admin/users");
  if (!res.ok) throw new Error("Failed to fetch users");
  return res.json();
}

export async function createUser(payload: CreateUserPayload): Promise<void> {
  const res = await fetch("/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function deleteUser(id: string): Promise<void> {
  const res = await fetch(`/api/admin/users/${id}`, {
    method: "DELETE"
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function getSystemSettings(): Promise<Record<string, string>> {
  const res = await fetch("/api/admin/settings");
  if (!res.ok) throw new Error("Failed to fetch system settings");
  return res.json();
}

export async function updateSystemSettings(settings: Record<string, string>): Promise<void> {
  const res = await fetch("/api/admin/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings)
  });
  if (!res.ok) throw new Error(await res.text());
}

export interface DatabaseMigrationStats {
  completed: boolean;
  totalAvailable: number;
  appliedCount: number;
  pendingCount: number;
  lastApplied: string | null;
  pendingFiles: string[];
}

export interface DatabaseStatusResponse {
  databaseService: string;
  isTurso: boolean;
  configured: boolean;
  migrations: DatabaseMigrationStats | null;
}

export interface RunMigrationsResponse {
  success: boolean;
  appliedCount: number;
  message?: string;
  stats?: DatabaseMigrationStats;
}

export async function getDatabaseStatus(): Promise<DatabaseStatusResponse> {
  const res = await fetch("/api/admin/database");
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function runDatabaseMigrations(): Promise<RunMigrationsResponse> {
  const res = await fetch("/api/admin/database/migrate", {
    method: "POST"
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export interface BackupLastSuccess {
  file: string;
  sizeBytes: number;
  finishedAt: number;
  uploaded?: boolean;
}

export interface BackupJobStatus {
  state: "running" | "success" | "failed";
  /** true only while the backup process is actually alive */
  running: boolean;
  trigger?: string;
  /** starting | snapshot | archive | verify | upload */
  phase?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  error?: string;
  file?: string;
  sizeBytes?: number;
  lastSuccess?: BackupLastSuccess | null;
}

export interface BackupStatusResponse {
  configured: boolean;
  endpoint?: string | null;
  bucket?: string | null;
  region?: string | null;
  prefix?: string | null;
  cron?: string | null;
  keepDays?: number | null;
  job?: BackupJobStatus | null;
}

export interface BackupItem {
  name: string;
  size: number;
  lastModified: number;
}

export async function getBackupStatus(): Promise<BackupStatusResponse> {
  const res = await fetch("/api/admin/backup");
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function testBackupConnection(): Promise<{ success: boolean; message: string }> {
  const res = await fetch("/api/admin/backup/test", { method: "POST" });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || "Connection test failed");
  }
  return data;
}

/**
 * Starts a backup in the background. Resolves immediately (HTTP 202); progress is read with getBackupStatus().
 * `alreadyRunning` is true when a backup (e.g. the scheduled one) is already in progress.
 */
export async function startBackup(): Promise<{ alreadyRunning: boolean }> {
  const res = await fetch("/api/admin/backup/run", { method: "POST" });
  if (res.status === 409) return { alreadyRunning: true };
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    throw new Error(data.error || "Failed to start backup");
  }
  return { alreadyRunning: false };
}

export async function listBackups(): Promise<BackupItem[]> {
  const res = await fetch("/api/admin/backup/list");
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    throw new Error(data.error || "Failed to list backups");
  }
  return data.backups as BackupItem[];
}

/**
 * Starts a download of a stored backup. The server only signs a short-lived URL; the browser then downloads
 * straight from S3 / R2, so the VPS does not carry the traffic and the browser shows normal download progress.
 */
export async function downloadBackup(name: string): Promise<void> {
  const res = await fetch("/api/admin/backup/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success || !data.url) {
    throw new Error(data.error || "Download failed");
  }
  const a = document.createElement("a");
  a.href = data.url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
