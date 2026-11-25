/**
 * Generates all_fixes.patch using git diff --no-index to ensure 100% git-compliant hunks.
 *
 * Usage: node scripts/make_patch.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = 'D:\\Anh_2026_v1\\ObexDNS-main (64)\\ObexDNS-main';
const NEW  = 'D:\\Anh_2026_v1\\ObexDNS-fork-new\\ObexDNS-main';
const OUT  = path.join(NEW, 'all_fixes.patch');

// Files that were added (no baseline counterpart)
const ADDED = [
  'src/lib/authCache.ts',
];

// Files that were modified (exist in both baseline and fork)
const MODIFIED = [
  'src/index.ts',
  'src/api/account/me.ts',
  'src/api/account/admin.ts',
  'src/api/auth/login.ts',
  'src/api/auth/register.ts',
  'src/api/auth/forgotPassword.ts',
  'src/models/user/core.ts',
  'src/lib/turso/migrate.ts',
  'src/lib/middleware.ts',
  'src/lib/session.ts',
  'web/src/services/account.ts',
  'web/src/i18n/locales/en-US.json',
  'web/src/i18n/locales/vi-VN.json',
  'web/src/utils/auth.ts',
  'web/src/views/AccountView/index.tsx',
  'web/src/views/AccountView/components/SystemSettingsCard.tsx',
  'web/src/views/AccountView/components/UserManagementCard.tsx',
  'web/src/views/AccountView/components/DeleteUserDialog.tsx',
  'web/src/views/AccountView/components/ActiveSessionsCard.tsx',
  'web/src/views/AccountView/components/MfaCard.tsx',
  'web/src/views/AccountView/components/DangerZoneCard.tsx',
  'web/src/views/DashboardHomeView/index.tsx',
  'web/src/views/DashboardHomeView/components/ProfileList.tsx',
  'web/src/views/SystemView/index.tsx',
  'web/src/App.tsx',
];

let patch = '';
let changed = 0;

for (const rel of MODIFIED) {
  const orig = path.join(BASE, rel);
  const updated = path.join(NEW, rel);
  if (!fs.existsSync(orig)) { console.warn(`SKIP (no baseline): ${rel}`); continue; }
  if (!fs.existsSync(updated)) { console.warn(`SKIP (not in fork): ${rel}`); continue; }

  const relFwd = rel.replace(/\\/g, '/');
  try {
    // git diff exits 1 when files differ, 0 when identical
    execSync(`git diff --no-index -- "${orig}" "${updated}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    if (err.stdout) {
      let chunk = err.stdout;
      // Normalize header to standard a/path and b/path
      const lines = chunk.split('\n');
      const cleanLines = [];
      for (const line of lines) {
        if (line.startsWith('diff --git ')) {
          cleanLines.push(`diff --git a/${relFwd} b/${relFwd}`);
        } else if (line.startsWith('--- ')) {
          cleanLines.push(`--- a/${relFwd}`);
        } else if (line.startsWith('+++ ')) {
          cleanLines.push(`+++ b/${relFwd}`);
        } else {
          cleanLines.push(line);
        }
      }
      patch += cleanLines.join('\n');
      if (!patch.endsWith('\n')) patch += '\n';
      changed++;
    }
  }
}

for (const rel of ADDED) {
  const updated = path.join(NEW, rel);
  if (!fs.existsSync(updated)) { console.warn(`SKIP (not in fork): ${rel}`); continue; }
  const relFwd = rel.replace(/\\/g, '/');
  try {
    // Diff against NUL /dev/null
    execSync(`git diff --no-index -- /dev/null "${updated}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    if (err.stdout) {
      let chunk = err.stdout;
      const lines = chunk.split('\n');
      const cleanLines = [];
      for (const line of lines) {
        if (line.startsWith('diff --git ')) {
          cleanLines.push(`diff --git a/${relFwd} b/${relFwd}`);
        } else if (line.startsWith('--- ')) {
          cleanLines.push(`--- /dev/null`);
        } else if (line.startsWith('+++ ')) {
          cleanLines.push(`+++ b/${relFwd}`);
        } else {
          cleanLines.push(line);
        }
      }
      patch += cleanLines.join('\n');
      if (!patch.endsWith('\n')) patch += '\n';
      changed++;
    }
  }
}

fs.writeFileSync(OUT, patch, 'utf8');
const sizeKb = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(`Patch written: ${OUT} (${sizeKb} KB, ${changed} files)`);
