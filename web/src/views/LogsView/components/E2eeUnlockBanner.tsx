import React from "react";
import { Button, Callout, Intent } from "@blueprintjs/core";
import { Key } from "lucide-react";
import { clsx } from "clsx";
import { useTranslation } from "react-i18next";

export interface E2eeUnlockBannerProps {
  isMobile: boolean;
  unlocking: boolean;
  onUnlockPasskey: () => void;
  onOpenRecoveryDialog: () => void;
}

/**
 * Banner shown on top of the logs view when client-side log encryption is enabled
 * but the current session has not unlocked the private key.
 */
export const E2eeUnlockBanner: React.FC<E2eeUnlockBannerProps> = ({
  isMobile,
  unlocking,
  onUnlockPasskey,
  onOpenRecoveryDialog
}) => {
  const { t } = useTranslation();

  return (
    <div className={clsx("mb-2 shrink-0", isMobile ? "px-2" : "px-4")}>
      <Callout
        intent={Intent.PRIMARY}
        icon="lock"
        title={t("settings.e2eeTitle", "Log End-to-End Encryption (E2EE)")}
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mt-1">
          <p className="text-xs opacity-80 m-0">
            {t("settings.e2eeUnlockPrompt", "This profile uses End-to-End Encryption. Verify your Passkey to decrypt and view plaintext logs."
            )}
          </p>
          <div className="flex items-center gap-2 flex-wrap shrink-0">
            <Button
              intent={Intent.PRIMARY}
              icon="key"
              small
              loading={unlocking}
              onClick={onUnlockPasskey}
              className="font-medium"
            >
              {t("settings.e2eeUnlockNow", "Unlock Encrypted Logs")}
            </Button>
            <Button
              intent={Intent.NONE}
              icon={<Key size={14} />}
              small
              disabled={unlocking}
              onClick={onOpenRecoveryDialog}
              className="font-medium"
            >
              {t("settings.e2eeUnlockRecovery", "Unlock with Recovery Key")}
            </Button>
          </div>
        </div>
      </Callout>
    </div>
  );
};
