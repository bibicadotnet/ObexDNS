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

export interface BackupStatusResponse {
  configured: boolean;
  endpoint?: string | null;
  bucket?: string | null;
  region?: string | null;
  prefix?: string | null;
  cron?: string | null;
  keepDays?: number | null;
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

export async function runManualBackup(): Promise<{ success: boolean; message: string }> {
  const res = await fetch("/api/admin/backup/run", { method: "POST" });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || "Manual backup failed");
  }
  return data;
}

export async function downloadBackup(): Promise<void> {
  const res = await fetch("/api/admin/backup/download");
  if (!res.ok) {
    let err = "Download failed";
    try {
      const data = await res.json();
      err = data.error || err;
    } catch {}
    throw new Error(err);
  }
  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const disp = res.headers.get("Content-Disposition");
  let filename = "obexdns_backup.tar.gz";
  if (disp && disp.includes("filename=")) {
    filename = disp.split("filename=")[1].replace(/["']/g, "").trim();
  }
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}
