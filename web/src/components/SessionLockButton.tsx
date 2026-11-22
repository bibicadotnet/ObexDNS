import React, { useState } from "react";
import { Button, Spinner } from "@blueprintjs/core";
import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { lockSession } from "../services";
import type { UserInfo } from "../types/auth";

/**
 * Locks the current session (shows the PIN screen) when a PIN is configured.
 * Shared by every place that offers a "Lock now" action.
 */
export function useLockSession(currentUser?: UserInfo | null) {
  const [locking, setLocking] = useState(false);
  const canLock = Boolean(currentUser?.pin_enabled);

  const lock = async () => {
    if (locking || !canLock) return;
    setLocking(true);
    try {
      await lockSession();
    } catch (err) {
      console.warn("Failed to lock session on server", err);
    } finally {
      sessionStorage.setItem("obex_session_locked", "true");
      window.dispatchEvent(new Event("session_paused"));
      setLocking(false);
    }
  };

  return { lock, locking, canLock };
}

export interface SessionLockButtonProps {
  /** Current logged in user info. Used to check if PIN is configured. */
  currentUser?: UserInfo | null;
  /** Whether button uses minimal styling. Defaults to true. */
  minimal?: boolean;
  /** Size of the button. Defaults to "small". */
  size?: "small" | "medium" | "large";
}

/**
 * Icon button that locks the session. Rendered only when a PIN code is configured.
 */
export const SessionLockButton: React.FC<SessionLockButtonProps> = ({
  currentUser,
  minimal = true,
  size = "small",
}) => {
  const { t } = useTranslation();
  const { lock, locking, canLock } = useLockSession(currentUser);

  if (!canLock) return null;

  return (
    <Button
      variant={minimal ? "minimal" : undefined}
      size={size}
      icon={locking ? <Spinner size={16} /> : <Lock size={16} />}
      onClick={lock}
      disabled={locking}
      title={t("auth.lockNow", "Lock Now")}
      aria-label={t("auth.lockNow", "Lock Now")}
    />
  );
};
