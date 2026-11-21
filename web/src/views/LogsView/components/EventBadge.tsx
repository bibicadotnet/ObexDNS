import React from "react";
import { Tag } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import type { LogEntry } from "../types";
import { eventIntent, getLogEvent } from "../utils/logEvent";

export interface EventBadgeProps {
  log: Pick<LogEntry, "event">;
  className?: string;
}

/** Small badge that tells why a log row exists (new / changed / ...). Renders a dash for rows without an event. */
export const EventBadge: React.FC<EventBadgeProps> = ({ log, className }) => {
  const { t } = useTranslation();
  const event = getLogEvent(log);
  if (!event) return <span className="opacity-30">-</span>;
  const intent = eventIntent(event);
  return (
    <Tag
      minimal
      round
      intent={intent === "none" ? undefined : intent}
      className={className ?? "text-[10px]"}
      title={t(`logs.eventHint.${event}`)}
    >
      {t(`logs.event.${event}`)}
    </Tag>
  );
};
