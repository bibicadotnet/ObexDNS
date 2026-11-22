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
      confirmButtonText={t("account.e2ee.confirmResetBtn")}
      cancelButtonText={t("common.cancel")}
      intent={Intent.DANGER}
      icon="reset"
      onConfirm={onConfirm}
      onCancel={onCancel}
      loading={processing}
    >
      <div className="space-y-2 text-xs">
        <p className="font-semibold text-gray-900 ">
          {t("account.e2ee.resetKeypairTitle")}
        </p>
        <p>
          {t("account.e2ee.resetKeypairDesc")}
        </p>
        <p className="text-gray-500 ">
          {hasPasskey
            ? t("account.e2ee.resetKeypairPasskeyNotice")
            : t("account.e2ee.resetKeypairRecoveryNotice")}
        </p>
      </div>
    </Alert>
  );
};
