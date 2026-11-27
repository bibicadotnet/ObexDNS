/**
 * @file logsWs.ts
 * @description Client-side WebSocket service for real-time DNS log streaming and gap synchronization.
 * Handles automatic reconnects, heartbeats, client-side E2EE decryption, and local SQLite ingestion.
 */

import type { LogEntry } from '../views/LogsView/types';
import { localDb } from './localDb';
import { e2ee } from './e2ee';
import { getAccessToken, setAccessToken } from '../utils/token';
import { refresh } from './auth';

export interface LogWsMessage {
  type: 'NEW_LOGS' | 'SYNC_DATA' | 'PONG' | 'ERROR';
  logs?: LogEntry[];
  latestTimestamp?: number;
  latestId?: number;
  hasMore?: boolean;
  message?: string;
}

/** Give up on WebSocket after this many failures in a row if it has never connected (e.g. unsupported server). */
const MAX_INITIAL_WS_FAILURES = 3;

class LogsWsService {
  private ws: WebSocket | null = null;
  private activeProfileId: string | null = null;
  private isConnected = false;
  private lastTimestamp = 0;
  private lastId = 0;
  private reconnectAttempts = 0;
  /** True once any connection of this page session has opened successfully. */
  private everOpened = false;
  private initialFailures = 0;
  /** Set when the server never accepts WebSocket; callers then rely on the HTTP polling fallback. */
  private wsUnavailable = false;
  /** Set by the reconnect timer so connect() keeps the backoff counter instead of resetting it. */
  private isReconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private readonly newLogsListeners = new Set<(logs: LogEntry[]) => void>();
  private readonly statusListeners = new Set<(connected: boolean) => void>();
  private syncResolver: ((logs: LogEntry[]) => void) | null = null;

  /**
   * Connects to the profile's real-time WebSocket log streaming endpoint.
   *
   * @param profileId - Profile identifier
   * @param sinceTimestamp - Earliest timestamp to start streaming from
   * @param lastId - Optional last known log ID for sub-second tie breaking
   */
  connect(profileId: string, sinceTimestamp: number, lastId?: number): void {
    if (this.wsUnavailable) return;

    if (
      this.ws &&
      this.activeProfileId === profileId &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      this.updateCursor(sinceTimestamp, lastId);
      return;
    }

    // disconnect() resets the backoff counter; a reconnect must keep it, otherwise the delay never grows
    // and every retry looks like the first one (which also refreshes the token each time).
    const keepBackoff = this.isReconnecting;
    this.isReconnecting = false;
    const attempts = this.reconnectAttempts;
    this.disconnect();
    if (keepBackoff) this.reconnectAttempts = attempts;
    this.activeProfileId = profileId;
    this.lastTimestamp = sinceTimestamp;
    this.lastId = lastId || 0;

    const token = getAccessToken();
    if (!token) {
      void refresh()
        .then((data) => {
          setAccessToken(data.accessToken);
          this.connect(profileId, sinceTimestamp, lastId);
        })
        .catch(() => {
          this.scheduleReconnect();
        });
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/profiles/${encodeURIComponent(profileId)}/logs/ws?token=${encodeURIComponent(token)}`;

    try {
      this.ws = new WebSocket(wsUrl);
      this.setupHandlers(this.ws, profileId);
    } catch (err: unknown) {
      console.warn('[Logs WS] Connection creation failed:', err);
      this.scheduleReconnect();
    }
  }

  /**
   * Disconnects the active WebSocket and clears reconnect/heartbeat timers.
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignored
      }
      this.ws = null;
    }
    this.activeProfileId = null;
    this.reconnectAttempts = 0;
    this.notifyStatus(false);
  }

  /**
   * Advances the client's current position cursor to prevent receiving duplicated logs.
   *
   * @param timestamp - Latest known log timestamp
   * @param id - Latest known log ID
   */
  updateCursor(timestamp: number, id?: number): void {
    if (timestamp > this.lastTimestamp || (timestamp === this.lastTimestamp && (id || 0) > this.lastId)) {
      this.lastTimestamp = timestamp;
      this.lastId = id || 0;
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: 'CHECK_NEW',
            sinceTimestamp: this.lastTimestamp,
            lastId: this.lastId,
          })
        );
      }
    }
  }

  /**
   * Requests a specific gap range directly over the WebSocket connection.
   *
   * @param since - Start timestamp in seconds
   * @param until - End timestamp in seconds
   * @param limit - Maximum rows (default 100)
   * @returns Promise resolving to decrypted LogEntry array
   */
  async requestSyncGap(since: number, until: number, limit = 100): Promise<LogEntry[]> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.activeProfileId) {
      return [];
    }

    return new Promise<LogEntry[]>((resolve) => {
      this.syncResolver = resolve;
      this.ws?.send(
        JSON.stringify({
          type: 'SYNC_GAP',
          since,
          until,
          limit,
        })
      );

      // 5-second timeout safeguard
      setTimeout(() => {
        if (this.syncResolver === resolve) {
          this.syncResolver = null;
          resolve([]);
        }
      }, 5000);
    });
  }

  /**
   * Subscribes to real-time incoming log events.
   *
   * @param listener - Callback receiving newly pushed, decrypted logs
   * @returns Unsubscribe function
   */
  onNewLogs(listener: (logs: LogEntry[]) => void): () => void {
    this.newLogsListeners.add(listener);
    return () => {
      this.newLogsListeners.delete(listener);
    };
  }

  /**
   * Subscribes to WebSocket connection status changes.
   *
   * @param listener - Callback receiving connection status
   * @returns Unsubscribe function
   */
  onStatusChange(listener: (connected: boolean) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.isConnected);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /**
   * Returns whether the WebSocket is currently open and communicating.
   */
  get connected(): boolean {
    return this.isConnected;
  }

  private setupHandlers(ws: WebSocket, profileId: string): void {
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectAttempts = 0;
      this.everOpened = true;
      this.initialFailures = 0;
      this.notifyStatus(true);

      // Subscribe with initial cursor
      ws.send(
        JSON.stringify({
          type: 'SUBSCRIBE',
          sinceTimestamp: this.lastTimestamp,
          lastId: this.lastId,
        })
      );

      // Start 5-second probe interval to keep connection alive and trigger low-overhead checks
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'CHECK_NEW', sinceTimestamp: this.lastTimestamp, lastId: this.lastId }));
        }
      }, 5000);
    };

    ws.onmessage = async (event: MessageEvent) => {
      if (this.ws !== ws) return;
      try {
        const msg = JSON.parse(event.data as string) as LogWsMessage;

        if (msg.type === 'NEW_LOGS' && Array.isArray(msg.logs) && msg.logs.length > 0) {
          // Decrypt any E2EE fields
          const decryptedLogs = await e2ee.decryptLogsBatch(profileId, msg.logs);

          // Ingest into local SQLite database
          await localDb.batchInsertLogs(profileId, decryptedLogs);

          // Update cursor to newest entry
          if (msg.latestTimestamp) {
            this.lastTimestamp = Math.max(this.lastTimestamp, msg.latestTimestamp);
          }
          if (msg.latestId) {
            this.lastId = msg.latestId;
          }

          // Notify UI listeners
          this.newLogsListeners.forEach((fn) => fn(decryptedLogs));
        } else if (msg.type === 'SYNC_DATA' && Array.isArray(msg.logs)) {
          const decryptedLogs = await e2ee.decryptLogsBatch(profileId, msg.logs);
          await localDb.batchInsertLogs(profileId, decryptedLogs);

          if (this.syncResolver) {
            this.syncResolver(decryptedLogs);
            this.syncResolver = null;
          }
        }
      } catch (err: unknown) {
        console.warn('[Logs WS] Message handling error:', err);
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.notifyStatus(false);
      if (!this.everOpened) {
        this.initialFailures++;
        if (this.initialFailures >= MAX_INITIAL_WS_FAILURES) {
          // Never worked: stop hammering the server, the HTTP polling fallback keeps logs fresh.
          this.wsUnavailable = true;
          console.info('[Logs WS] Not available on this server, using HTTP polling instead.');
          return;
        }
      }
      this.scheduleReconnect();
    };

    ws.onerror = (err: Event) => {
      if (this.ws !== ws) return;
      console.warn('[Logs WS] Socket error:', err);
      try {
        ws.close();
      } catch {
        // Ignored
      }
    };
  }

  private scheduleReconnect(): void {
    if (!this.activeProfileId) return;

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 10000);

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (this.activeProfileId) {
        if (this.reconnectAttempts === 1) {
          void refresh()
            .then((data) => {
              setAccessToken(data.accessToken);
            })
            .catch(() => {})
            .finally(() => {
              if (this.activeProfileId) {
                this.isReconnecting = true;
                this.connect(this.activeProfileId, this.lastTimestamp, this.lastId);
              }
            });
        } else {
          this.isReconnecting = true;
          this.connect(this.activeProfileId, this.lastTimestamp, this.lastId);
        }
      }
    }, delay);
  }

  private notifyStatus(connected: boolean): void {
    this.isConnected = connected;
    this.statusListeners.forEach((fn) => fn(connected));
  }
}

export const logsWs = new LogsWsService();
