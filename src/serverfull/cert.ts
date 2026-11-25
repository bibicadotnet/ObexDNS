/**
 * @file cert.ts
 * @description TLS certificate validation, wildcard detection, and certbot guidance utilities for Serverfull mode.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import tls from 'node:tls';
import { DiagnosticConfig } from './format';

export interface TlsCertificateInfo {
  configured: boolean;
  filesExist: boolean;
  certPath: string;
  keyPath: string;
  isWildcard: boolean;
  domains: string[];
  expiresAt: Date | null;
  error?: string;
}

/**
 * Inspects certificate files on disk and checks if they contain a wildcard domain (*.domain).
 *
 * @param certPath - Path to certificate PEM file.
 * @param keyPath - Path to private key PEM file.
 * @returns TlsCertificateInfo with detailed inspection results.
 */
export function inspectTlsCertificate(certPath: string, keyPath: string): TlsCertificateInfo {
  const configured = Boolean(certPath && keyPath);
  if (!configured) {
    return {
      configured: false,
      filesExist: false,
      certPath: certPath || '',
      keyPath: keyPath || '',
      isWildcard: false,
      domains: [],
      expiresAt: null
    };
  }

  let certAccessible = false;
  let keyAccessible = false;
  let accessError: string | undefined;

  try {
    fs.accessSync(certPath, fs.constants.R_OK);
    certAccessible = true;
  } catch (err: unknown) {
    const errCode = (err as { code?: string })?.code;
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errCode === 'EACCES') {
      accessError = `Permission denied (EACCES) reading certPath: ${certPath}`;
    } else if (errCode === 'ENOENT') {
      accessError = `Certificate file not found: ${certPath}`;
    } else {
      accessError = `Cannot read certPath (${certPath}): ${errMsg}`;
    }
  }

  try {
    fs.accessSync(keyPath, fs.constants.R_OK);
    keyAccessible = true;
  } catch (err: unknown) {
    const errCode = (err as { code?: string })?.code;
    const errMsg = err instanceof Error ? err.message : String(err);
    const keyMsg = errCode === 'EACCES'
      ? `Permission denied (EACCES) reading keyPath: ${keyPath}`
      : errCode === 'ENOENT'
        ? `Private key file not found: ${keyPath}`
        : `Cannot read keyPath (${keyPath}): ${errMsg}`;
    accessError = accessError ? `${accessError}; ${keyMsg}` : keyMsg;
  }

  const filesExist = certAccessible && keyAccessible;
  if (!filesExist) {
    return {
      configured: true,
      filesExist: false,
      certPath,
      keyPath,
      isWildcard: false,
      domains: [],
      expiresAt: null,
      error: accessError
    };
  }

  try {
    const certContent = fs.readFileSync(certPath, 'utf-8');
    const x509 = new crypto.X509Certificate(certContent);

    const domains: string[] = [];
    let isWildcard = false;

    // Check Subject Alternative Names (SANs)
    if (x509.subjectAltName) {
      const parts = x509.subjectAltName.split(',').map((p) => p.trim());
      for (const part of parts) {
        if (part.startsWith('DNS:')) {
          const d = part.slice(4).trim().toLowerCase();
          if (!domains.includes(d)) {
            domains.push(d);
          }
          if (d.startsWith('*.')) {
            isWildcard = true;
          }
        }
      }
    }

    // Check Common Name (CN) from subject if not already captured
    if (x509.subject) {
      const match = x509.subject.match(/CN=([^,\n\/]+)/i);
      if (match) {
        const cn = match[1].trim().toLowerCase();
        if (!domains.includes(cn)) {
          domains.push(cn);
        }
        if (cn.startsWith('*.')) {
          isWildcard = true;
        }
      }
    }

    const expiresAt = new Date(x509.validTo);

    return {
      configured: true,
      filesExist: true,
      certPath,
      keyPath,
      isWildcard,
      domains,
      expiresAt
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      configured: true,
      filesExist: true,
      certPath,
      keyPath,
      isWildcard: false,
      domains: [],
      expiresAt: null,
      error: errorMsg
    };
  }
}

/**
 * Builds the canonical certbot wildcard registration command.
 *
 * @param targetDomain - Base domain or fallback to 'your.domain'.
 * @returns Shell command string for certbot DNS challenge.
 */
export function getCertbotCommand(targetDomain?: string): string {
  const cleanDomain = targetDomain ? targetDomain.replace(/^\*\./, '').trim() : 'your.domain';
  return `certbot certonly -d *.${cleanDomain} -d ${cleanDomain} --manual --preferred-challenges dns`;
}

/**
 * Generates formatted diagnostic guidance for obtaining or upgrading a TLS certificate via Certbot.
 *
 * @param reason - 'missing' | 'non_wildcard'
 * @param targetDomain - Optional base domain to personalize the command.
 * @returns DiagnosticOptions formatted for formatDiagnostic().
 */
export function getCertbotDiagnosticOptions(
  reason: 'missing' | 'non_wildcard',
  targetDomain?: string
): DiagnosticConfig {
  const cmd = getCertbotCommand(targetDomain);

  if (reason === 'missing') {
    return {
      level: 'warning',
      title: 'TLS Certificate Not Configured / Missing',
      message: 'No valid TLS certificate detected. HTTPS Web UI and DoT (port 853) are disabled.',
      details: [
        'Plain HTTP Web UI and Classic UDP DNS (port 53) remain fully operational.'
      ],
      solutions: [
        'To enable HTTPS and DoT with per-profile routing, register a free wildcard certificate using certbot:',
        `  ${cmd}`,
        'Then configure SERVERFULL_TLS_CERT_PATH and SERVERFULL_TLS_KEY_PATH in your .env file.'
      ]
    };
  }

  return {
    level: 'warning',
    title: 'Non-Wildcard TLS Certificate Detected (DoT Paused)',
    message: 'The current certificate does not cover wildcard subdomains (*.domain). DoT (DNS over TLS / DoQ) is paused until a valid wildcard certificate is installed.',
    details: [
      'DoT requires a wildcard certificate (*.domain) to securely route queries to specific profiles via TLS SNI (<profileKey>.your.domain).',
      'The policy allowing access to Default Profile without a wildcard certificate has been disabled.'
    ],
    solutions: [
      'You can register a wildcard certificate using Certbot via DNS challenge:',
      `  ${cmd}`,
      'Then update SERVERFULL_TLS_CERT_PATH and SERVERFULL_TLS_KEY_PATH to resume DoT service.'
    ]
  };
}

/** Minimal server shape shared by tls.Server and http2.Http2SecureServer. */
export interface CertReloadableServer {
  prependListener?(event: 'connection', listener: () => void): unknown;
  on?(event: 'connection', listener: () => void): unknown;
  setSecureContext(options: tls.SecureContextOptions): void;
}

/**
 * Makes a TLS server pick up renewed certificates (e.g. after Certbot) without a restart.
 *
 * There are no watchers or timers: when a new TCP connection arrives, and at most once per
 * `minIntervalMs`, the cert/key files are stat()ed. Only if they changed are they re-read and
 * applied with `server.setSecureContext()`, which affects every subsequent handshake
 * (existing connections keep the old certificate until they close). An idle server costs nothing.
 *
 * A failed reload (files missing or mid-write, cert/key mismatch) is logged and the previous
 * certificate keeps being served; it is retried automatically as soon as the files change again.
 */
export function enableCertAutoReload(
  server: CertReloadableServer,
  certPath: string,
  keyPath: string,
  label: string,
  minIntervalMs = 60_000
): void {
  const signature = (): string => {
    const c = fs.statSync(certPath); // statSync follows Certbot's live/ -> archive/ symlinks
    const k = fs.statSync(keyPath);
    return `${c.ino}:${c.size}:${c.mtimeMs}|${k.ino}:${k.size}:${k.mtimeMs}`;
  };

  let lastSignature = '';
  try { lastSignature = signature(); } catch { /* files checked again on first interval */ }
  let lastCheck = Date.now();

  const onConnection = () => {
    const now = Date.now();
    if (now - lastCheck < minIntervalMs) return;
    lastCheck = now;

    let current: string;
    try {
      current = signature();
    } catch {
      return; // transient (e.g. mid-renewal): keep serving the current certificate
    }
    if (current === lastSignature) return;
    lastSignature = current;

    try {
      const cert = fs.readFileSync(certPath);
      const key = fs.readFileSync(keyPath);
      tls.createSecureContext({ cert, key }); // throws if the pair is invalid or mismatched
      server.setSecureContext({ cert, key });
      console.log(`[${label}] TLS certificate reloaded from disk.`);
    } catch (err: any) {
      console.error(`[${label}] TLS certificate changed but reload failed, keeping the previous one:`, err?.message || err);
    }
  };

  // Never let a runtime quirk stop the server from starting: worst case, reload simply stays off.
  try {
    // Prepend where possible so the very connection that triggers a reload already gets the new cert.
    if (typeof server.prependListener === 'function') server.prependListener('connection', onConnection);
    else server.on?.('connection', onConnection);
  } catch (err: any) {
    console.warn(`[${label}] TLS certificate auto-reload unavailable:`, err?.message || err);
  }
}
