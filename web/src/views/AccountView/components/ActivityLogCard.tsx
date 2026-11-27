import React, { useState, useEffect, useCallback } from "react";
import { Card, Elevation, H4, Tag, Button, Intent, HTMLTable, Spinner } from "@blueprintjs/core";
import { Activity, RefreshCw, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";
import { CompactDateTime } from "../../../components/CompactDateTime";
import { useContainerWidth } from "../../../hooks/useContainerWidth";
import { ACTION_META } from "../constants";
import { getActivityLog } from "../../../services";
import type { ActivityEntry } from "../../../services";
import { UserAgentDisplay } from "./UserAgentDisplay";

const TABLE_MIN_WIDTH = 768;

interface ActivityLogCardProps {
  hoveredSessionId?: string | null;
  setHoveredSessionId?: (id: string | null) => void;
}

export const ActivityLogCard: React.FC<ActivityLogCardProps> = ({
  hoveredSessionId,
  setHoveredSessionId
}) => {
  const { t } = useTranslation();
  const [containerRef, containerWidth] = useContainerWidth();
  const showCards = containerWidth > 0 && containerWidth < TABLE_MIN_WIDTH;
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const fetchActivity = useCallback(async (before?: number) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "20" });
      if (before) params.set("before", String(before));
      const data = await getActivityLog(params.toString());
      if (before) {
        setEntries((prev) => [...prev, ...data]);
      } else {
        setEntries(data);
      }
      setHasMore(data.length === 20);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchActivity();
  }, [fetchActivity]);

  const handleLoadMore = () => {
    const last = entries[entries.length - 1];
    if (last) fetchActivity(last.timestamp);
  };

  const getActionMeta = (action: string) =>
    ACTION_META[action] ?? {
      label: action,
      icon: <Activity size={14} />,
      intent: Intent.NONE,
    };

  return (
    <Card elevation={Elevation.ONE}>
      <div
        className="flex items-center justify-between cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          <Activity size={20} className="text-purple-500" />
          <H4 className="section-title">
            {t("account.activity.title", "Account Activity")}
          </H4>
          {entries.length > 0 && (
            <Tag minimal round intent={Intent.NONE}>
              {entries.length}
              {hasMore ? "+" : ""}
            </Tag>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            minimal
            icon={<RefreshCw size={14} />}
            onClick={(e) => {
              e.stopPropagation();
              fetchActivity();
            }}
          />
          <ChevronDown
            size={16}
            className={`text-gray-400 transition-transform ${
              expanded ? "rotate-180" : ""
            }`}
          />
        </div>
      </div>

      {expanded && (
        <div className="mt-4">
          {loading && entries.length === 0 ? (
            <div className="flex justify-center py-8">
              <Spinner size={24} />
            </div>
          ) : entries.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-6">
              {t("account.activity.empty", "No activity recorded yet.")}
            </p>
          ) : showCards ? (
            <div ref={containerRef} className="w-full min-w-0 pb-2">
              <div className="flex flex-col gap-3">
                {entries.map((entry) => {
                  const meta = getActionMeta(entry.action);
                  let reasonText = "";
                  const sessionId = entry.session_id_hash || "";
                  if (entry.extra) {
                    try {
                      const parsed = JSON.parse(entry.extra);
                      if (parsed.reason) {
                        const translationKey = `account.activity.reasons.${parsed.reason}`;
                        const translated = t(translationKey);
                        if (translated && translated !== translationKey) {
                          reasonText = translated;
                        } else {
                          reasonText = parsed.reason
                            .replace(/[_-]+/g, " ")
                            .replace(/\b\w/g, (char: string) => char.toUpperCase());
                        }
                      }
                    } catch {
                      /* ignore */
                    }
                  }
                  return (
                    <div
                      key={entry.id}
                      onMouseEnter={() => {
                        if (sessionId) setHoveredSessionId?.(sessionId);
                      }}
                      onMouseLeave={() => {
                        if (sessionId) setHoveredSessionId?.(null);
                      }}
                      className={clsx(
                        "p-4 rounded-xl border border-gray-200 bg-white shadow-xs space-y-3 transition-colors",
                        hoveredSessionId && hoveredSessionId === sessionId && "bg-gray-50/80"
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex flex-col items-start gap-1 min-w-0">
                          <Tag minimal intent={meta.intent} icon={meta.icon as any}>
                            {t(meta.label, entry.action)}
                          </Tag>
                          {reasonText && (
                            <span className="text-xs text-gray-500 italic">
                              {reasonText}
                            </span>
                          )}
                        </div>
                        <div className="text-right shrink-0">
                          <CompactDateTime timestamp={entry.timestamp} align="right" />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2 pt-2 border-t border-gray-100 text-xs">
                        <div>
                          <span className="text-gray-400 block text-[11px] uppercase tracking-wide mb-0.5">
                            {t("account.activity.device", "Device")}
                          </span>
                          <UserAgentDisplay userAgent={entry.user_agent || null} />
                        </div>
                        <div className="font-mono text-gray-500">
                          <div>
                            <span className="text-gray-400 block text-[11px] uppercase tracking-wide mb-0.5">
                              {t("account.activity.session", "Session")}
                            </span>
                            <span>ID: {sessionId ? sessionId.slice(0, 8) : "—"}</span>
                            {entry.ip_address && (
                              <span className="block text-gray-400">IP: {entry.ip_address}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div ref={containerRef} className="overflow-hidden rounded-xl border border-gray-200">
              <HTMLTable interactive striped className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 whitespace-nowrap">
                    <th className="py-2.5 px-3">{t("account.activity.action", "Action")}</th>
                    <th className="py-2.5 px-3">{t("account.activity.time", "Time")}</th>
                    <th className="py-2.5 px-3">{t("account.activity.session", "Session")}</th>
                    <th className="py-2.5 px-3">{t("account.activity.ip", "IP Address")}</th>
                    <th className="py-2.5 px-3">{t("account.activity.device", "Device")}</th>
                  </tr>
                </thead>
                <tbody>
                   {entries.map((entry) => {
                    const meta = getActionMeta(entry.action);
                    let reasonText = "";
                    const sessionId = entry.session_id_hash || "";
                    if (entry.extra) {
                      try {
                        const parsed = JSON.parse(entry.extra);
                        if (parsed.reason) {
                          const translationKey = `account.activity.reasons.${parsed.reason}`;
                          const translated = t(translationKey);
                          if (translated && translated !== translationKey) {
                            reasonText = translated;
                          } else {
                            // Format snake_case / kebab-case string into Start Case
                            reasonText = parsed.reason
                              .replace(/[_-]+/g, " ")
                              .replace(/\b\w/g, (char: string) => char.toUpperCase());
                          }
                        }
                      } catch {
                        /* ignore */
                      }
                    }
                    return (
                      <tr 
                        key={entry.id}
                        onMouseEnter={() => {
                          if (sessionId) setHoveredSessionId?.(sessionId);
                        }}
                        onMouseLeave={() => {
                          if (sessionId) setHoveredSessionId?.(null);
                        }}
                        className={hoveredSessionId && hoveredSessionId === sessionId ? "bg-gray-100/80" : ""}
                      >
                        <td className="align-middle py-2.5 px-3">
                          <div className="flex flex-col items-start gap-1">
                            <Tag minimal intent={meta.intent} icon={meta.icon as any}>
                              {t(meta.label, entry.action)}
                            </Tag>
                            {reasonText && (
                              <span className="text-xs text-gray-500 italic ml-1">
                                {reasonText}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="whitespace-nowrap align-middle py-2.5 px-3">
                          <CompactDateTime timestamp={entry.timestamp} />
                        </td>
                        <td className="font-mono text-xs text-gray-500 align-middle py-2.5 px-3">
                          {sessionId ? sessionId.slice(0, 8) : "—"}
                        </td>
                        <td className="font-mono text-xs text-gray-500 align-middle py-2.5 px-3">
                          {entry.ip_address || "—"}
                        </td>
                        <td className="align-middle py-2.5 px-3">
                          <UserAgentDisplay userAgent={entry.user_agent || null} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </HTMLTable>
              {hasMore && (
                <div className="flex justify-center mt-3">
                  <Button
                    minimal
                    loading={loading}
                    text={t("account.activity.loadMore", "Load More")}
                    onClick={handleLoadMore}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
};
