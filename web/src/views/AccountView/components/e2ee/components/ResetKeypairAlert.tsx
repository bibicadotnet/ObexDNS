import React from "react";
import { Alert, Intent } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";

export interface ResetKeypairAlertProps {
  isOpen: boolean;
  processing: boolean;
  hasPasskey: boolean;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

/**
 * Confirmation dialog for purging inaccessible or desynchronized E2EE keys
 * and re-initializing a fresh post-quantum keypair.
 */
export const ResetKeypairAlert: React.FC<ResetKeypairAlertProps> = ({
  isOpen,
  processing,
  hasPasskey,
  onConfirm,
  onCancel
}) => {
  const { t } = useTranslation();

  return (
    <Alert
      isOpen={isOpen}
      confirmButtonText={t("account.e2ee.confirmResetBtn", "Confirm Reset & Re-generate")}
      cancelButtonText={t("common.cancel", "Cancel")}
      intent={Intent.DANGER}
      icon="reset"
      onConfirm={onConfirm}
      onCancel={onCancel}
      loading={processing}
    >
      <div className="space-y-2 text-xs">
        <p className="font-semibold text-gray-900">
          {t("account.e2ee.resetKeypairTitle", "Reset E2EE Keypair")}
        </p>
        <p>
          {t("account.e2ee.resetKeypairDesc", "If your recovery key does not match or cannot decrypt, and no passkeys are enrolled, resetting will purge old keys from the server and generate a brand-new post-quantum (P256-MLKEM768) keypair."
          )}
        </p>
        <p className="text-gray-500">
          {hasPasskey
            ? t("account.e2ee.resetKeypairPasskeyNotice", "Confirming will immediately invoke your configured Passkey to encrypt and authorize the new keypair."
              )
            : t("account.e2ee.resetKeypairRecoveryNotice", "Confirming will prompt you to enter your current Recovery Key to generate and encrypt the new keypair."
              )}
        </p>
      </div>
    </Alert>
  );
};
