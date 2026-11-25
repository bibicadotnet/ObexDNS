import React, { useState, useEffect, useCallback } from "react";
import { Card, Elevation, H4, Tag, Button, Intent, HTMLTable, Spinner, Alert } from "@blueprintjs/core";
import { Monitor, RefreshCw, LogOut } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CompactDateTime } from "../../../components/CompactDateTime";
import { useContainerWidth } from "../../../hooks/useContainerWidth";
import { clsx } from "clsx";
import { getSessions, revokeSession, revokeOtherSessions } from "../../../services";
import type { SessionInfo } from "../../../services";
import { UserAgentDisplay } from "./UserAgentDisplay";
import { formatApiErrorMessage } from "../../../utils/auth";
import type { OverlayToaster } from "@blueprintjs/core";

interface ActiveSessionsCardProps {
  hoveredSessionId?: string | null;
  setHoveredSessionId?: (id: string | null) => void;
  toasterRef?: React.RefObject<OverlayToaster | null>;
}

const TABLE_MIN_WIDTH = 768;

export const ActiveSessionsCard: React.FC<ActiveSessionsCardProps> = ({
  hoveredSessionId,
  setHoveredSessionId,
  toasterRef,
}) => {
  const { t } = useTranslation();
  const [containerRef, containerWidth] = useContainerWidth();
  const showCards = containerWidth > 0 && containerWidth < TABLE_MIN_WIDTH;
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);
  const [isRevokeOthersAlertOpen, setIsRevokeOthersAlertOpen] = useState(false);

  const otherSessionsCount = sessions.filter((s) => !s.is_current).length;

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getSessions();
      const now = Date.now();
      const activeOnly = (data || []).filter((s) => s.expires_at * 1000 > now);
      setSessions(activeOnly);
    } catch (e: any) {
      toasterRef?.current?.show({
        message: formatApiErrorMessage(e, t),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const handleRevoke = async (id: string) => {
    setRevoking(id);
    try {
      const data = await revokeSession(id);
      if (data.is_current) {
        window.location.href = "/";
      } else {
        setSessions((prev) => prev.filter((s) => s.id !== id));
      }
    } catch (e: any) {
      toasterRef?.current?.show({
        message: formatApiErrorMessage(e, t),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setRevoking(null);
    }
  };

  const handleConfirmRevokeOthers = async () => {
    setRevokingOthers(true);
    try {
      await revokeOtherSessions();
      setSessions((prev) => prev.filter((s) => s.is_current));
      setIsRevokeOthersAlertOpen(false);
    } catch (e: any) {
      toasterRef?.current?.show({
        message: formatApiErrorMessage(e, t),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setRevokingOthers(false);
    }
  };

  return (
    <Card elevation={Elevation.ONE}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2 flex-wrap">
          <Monitor size={20} className="text-green-500" />
          <H4 className="section-title">{t("account.sessions.title", "Active Sessions")}</H4>
        </div>
        <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
          {otherSessionsCount > 0 && (
            <Button
              small
              minimal
              intent={Intent.DANGER}
              icon={<LogOut size={14} />}
              text={t("account.sessions.revokeOthers", "Revoke Other Sessions")}
              loading={revokingOthers}
              onClick={() => setIsRevokeOthersAlertOpen(true)}
            />
          )}
          <Button
            minimal
            icon={<RefreshCw size={14} />}
            onClick={() => fetchSessions()}
          />
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-4">
          <Spinner size={24} />
        </div>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-4">
          {t("account.sessions.empty", "No active sessions found.")}
        </p>
      ) : showCards ? (
        <div ref={containerRef} className="w-full min-w-0 pb-2">
          <div className="flex flex-col gap-3">
            {sessions.map((session) => (
              <div
                key={session.id}
                onMouseEnter={() => setHoveredSessionId?.(session.id)}
                onMouseLeave={() => setHoveredSessionId?.(null)}
                className={clsx(
                  "p-4 rounded-xl border border-gray-200 bg-white shadow-xs space-y-3 transition-colors",
                  hoveredSessionId === session.id && "bg-gray-50/80"
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <UserAgentDisplay userAgent={session.user_agent} />
                      {session.is_current && (
                        <Tag minimal intent={Intent.SUCCESS}>
                          {t("account.sessions.current", "Current")}
                        </Tag>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-gray-500 font-mono">
                      <span>ID: {session.id ? session.id.slice(0, 8) : "—"}</span>
                      {session.ip_address && (
                        <>
                          <span>•</span>
                          <span>IP: {session.ip_address}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <Button
                    small
                    minimal
                    intent={Intent.DANGER}
                    disabled={session.is_current}
                    icon={<LogOut size={14} />}
                    text={t("account.sessions.revoke", "Revoke")}
                    loading={revoking === session.id}
                    onClick={() => handleRevoke(session.id)}
                  />
                </div>

                <div className="grid grid-cols-2 gap-2 pt-2 border-t border-gray-100 text-xs">
                  <div>
                    <span className="text-gray-400 block text-[11px] uppercase tracking-wide mb-0.5">
                      {t("account.sessions.loginTime", "Login Time")}
                    </span>
                    <CompactDateTime timestamp={session.created_at} />
                  </div>
                  <div>
                    <span className="text-gray-400 block text-[11px] uppercase tracking-wide mb-0.5">
                      {t("account.sessions.expires", "Expires")}
                    </span>
                    <CompactDateTime timestamp={session.expires_at} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div ref={containerRef} className="overflow-hidden rounded-xl border border-gray-200">
          <HTMLTable interactive striped className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 whitespace-nowrap">
                <th className="py-2.5 px-3">{t("account.sessions.device", "Device")}</th>
                <th className="py-2.5 px-3">{t("account.sessions.session", "Session")}</th>
                <th className="py-2.5 px-3">{t("account.sessions.ip", "IP Address")}</th>
                <th className="py-2.5 px-3">{t("account.sessions.loginTime", "Login Time")}</th>
                <th className="py-2.5 px-3">{t("account.sessions.expires", "Expires")}</th>
                <th className="py-2.5 px-3">{t("account.sessions.action", "Action")}</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr 
                  key={session.id}
                  onMouseEnter={() => setHoveredSessionId?.(session.id)}
                  onMouseLeave={() => setHoveredSessionId?.(null)}
                  className={hoveredSessionId === session.id ? "bg-gray-100/80" : ""}
                >
                  <td className="py-2.5 px-3">
                    <div className="flex items-start gap-2">
                      <UserAgentDisplay userAgent={session.user_agent} />
                      {session.is_current && (
                        <Tag minimal intent={Intent.SUCCESS} className="mt-0.5">
                          {t("account.sessions.current", "Current")}
                        </Tag>
                      )}
                    </div>
                  </td>
                  <td className="font-mono text-xs text-gray-500 align-middle py-2.5 px-3">
                    {session.id ? session.id.slice(0, 8) : "—"}
                  </td>
                  <td className="font-mono text-xs text-gray-500 align-middle py-2.5 px-3">
                    {session.ip_address || "—"}
                  </td>
                  <td className="align-middle py-2.5 px-3 whitespace-nowrap">
                    <CompactDateTime timestamp={session.created_at} />
                  </td>
                  <td className="align-middle py-2.5 px-3 whitespace-nowrap">
                    <CompactDateTime timestamp={session.expires_at} />
                  </td>
                  <td className="align-middle py-2.5 px-3">
                    <Button
                      small
                      minimal
                      intent={Intent.DANGER}
                      disabled={session.is_current}
                      icon={<LogOut size={14} />}
                      text={t("account.sessions.revoke", "Revoke")}
                      loading={revoking === session.id}
                      onClick={() => handleRevoke(session.id)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </HTMLTable>
        </div>
      )}

      <Alert
        isOpen={isRevokeOthersAlertOpen}
        cancelButtonText={t("common.cancel", "Cancel")}
        confirmButtonText={t("account.sessions.confirmRevokeOthers", "Revoke Other Sessions")}
        intent={Intent.DANGER}
        icon="log-out"
        onCancel={() => setIsRevokeOthersAlertOpen(false)}
        onConfirm={handleConfirmRevokeOthers}
        loading={revokingOthers}
      >
        <p>
          {t(
            "account.sessions.revokeOthersConfirmText",
            "Are you sure you want to revoke all other active sessions? All other logged-in devices will be signed out immediately."
          )}
        </p>
      </Alert>
    </Card>
  );
};
