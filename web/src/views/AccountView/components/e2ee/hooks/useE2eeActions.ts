/**
 * @file useE2eeActions.ts
 * @description Hook managing E2EE keypair lifecycle actions (unlock, upgrade PQC, enroll passkey, reset & reinit).
 */

import { useState } from "react";
import { Intent, OverlayToaster } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import { formatApiErrorMessage } from "../../../../../utils/auth";
import { e2ee } from "../../../../../services";
import { getPasskeys } from "../../../../../services/account";

export interface UseE2eeActionsProps {
  hasPasskey: boolean;
  onRefresh?: () => void;
  loadStatus: () => Promise<void>;
  setIsUnlocked: (val: boolean) => void;
  setInitRecoveryDialogOpen: (val: boolean) => void;
  toasterRef: React.RefObject<OverlayToaster | null>;
  setProcessing: (val: boolean) => void;
}

export function useE2eeActions({
  hasPasskey,
  onRefresh,
  loadStatus,
  setIsUnlocked,
  setInitRecoveryDialogOpen,
  toasterRef,
  setProcessing
}: UseE2eeActionsProps) {
  const { t } = useTranslation();
  const [isResetAlertOpen, setIsResetAlertOpen] = useState<boolean>(false);

  const handleUnlock = async () => {
    setProcessing(true);
    try {
      const success = await e2ee.unlockUser();
      if (success) {
        setIsUnlocked(true);
        toasterRef.current?.show({
          message: t("account.e2ee.unlockSuccess"),
          intent: Intent.SUCCESS,
          icon: "tick"
        });
      }
    } catch (err: unknown) {
      console.error("[useE2eeActions] Failed to unlock private key:", err);
      toasterRef.current?.show({
        message: formatApiErrorMessage(err, t),
        intent: Intent.DANGER,
        icon: "error"
      });
    } finally {
      setProcessing(false);
    }
  };

  const handleGenerateKeyWithPasskey = async () => {
    setProcessing(true);
    try {
      await e2ee.enableUserE2ee();
      toasterRef.current?.show({
        message: t("account.e2ee.keypairGenSuccess"),
        intent: Intent.SUCCESS,
        icon: "tick"
      });
      await loadStatus();
      onRefresh?.();
    } catch (err: unknown) {
      console.error("[useE2eeActions] Generate key with Passkey failed:", err);
      toasterRef.current?.show({
        message: formatApiErrorMessage(err, t),
        intent: Intent.DANGER,
        icon: "error"
      });
    } finally {
      setProcessing(false);
    }
  };

  const handleUpgradeToPqc = async () => {
    setProcessing(true);
    try {
      await e2ee.rotateUserE2eeKey();
      toasterRef.current?.show({
        message: t("account.e2ee.upgradePqcSuccess", "Successfully upgraded to Post-Quantum Hybrid Encryption (P256-MLKEM768)"),
        intent: Intent.SUCCESS,
        icon: "tick"
      });
      await loadStatus();
      onRefresh?.();
    } catch (err: unknown) {
      console.error("[useE2eeActions] Upgrade to PQC failed:", err);
      toasterRef.current?.show({
        message: formatApiErrorMessage(err, t),
        intent: Intent.DANGER,
        icon: "error"
      });
    } finally {
      setProcessing(false);
    }
  };

  const handleEnrollPasskey = async () => {
    setProcessing(true);
    try {
      const passkeys = await getPasskeys();
      const passkeyId = passkeys.length > 0 ? passkeys[0].id : "primary";
      const success = await e2ee.wrapCurrentKeyForPasskey(passkeyId);
      if (success) {
        toasterRef.current?.show({
          message: t("account.e2ee.enrollPasskeySuccess", "Passkey successfully enrolled into E2EE!"),
          intent: Intent.SUCCESS,
          icon: "tick"
        });
        await loadStatus();
        onRefresh?.();
      } else {
        throw new Error(t("account.e2ee.enrollPasskeyFailed", "Failed to enroll Passkey"));
      }
    } catch (err: unknown) {
      console.error("[useE2eeActions] Enroll passkey failed:", err);
      toasterRef.current?.show({
        message: formatApiErrorMessage(err, t),
        intent: Intent.DANGER,
        icon: "error"
      });
    } finally {
      setProcessing(false);
    }
  };

  const handleResetAndReinit = async () => {
    setProcessing(true);
    try {
      await fetch("/api/account/e2ee?purge=true", { method: "DELETE" });
      e2ee.clearStorage();

      if (hasPasskey) {
        await e2ee.enableUserE2ee();
        toasterRef.current?.show({
          message: t("account.e2ee.resetAndInitPasskeySuccess", "Keypair successfully reset and re-encrypted with your Passkey!"),
          intent: Intent.SUCCESS,
          icon: "tick"
        });
      } else {
        toasterRef.current?.show({
          message: t("account.e2ee.resetSuccessEnterRecovery", "Old keys purged. Please initialize a new keypair with your Recovery Key."),
          intent: Intent.WARNING,
          icon: "refresh"
        });
        setInitRecoveryDialogOpen(true);
      }
      await loadStatus();
      onRefresh?.();
    } catch (err: unknown) {
      console.error("[useE2eeActions] Reset keypair failed:", err);
      toasterRef.current?.show({
        message: formatApiErrorMessage(err, t),
        intent: Intent.DANGER,
        icon: "error"
      });
    } finally {
      setProcessing(false);
      setIsResetAlertOpen(false);
    }
  };

  return {
    handleUnlock,
    handleGenerateKeyWithPasskey,
    handleUpgradeToPqc,
    handleEnrollPasskey,
    isResetAlertOpen,
    setIsResetAlertOpen,
    handleResetAndReinit
  };
}
