import React from "react";
import { Button, Intent } from "@blueprintjs/core";
import { CheckCircle2 } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * Props for the ForgotPasswordSuccessStep component.
 */
export interface ForgotPasswordSuccessStepProps {
  /** Username of the account whose password was successfully reset. */
  username: string;
  /** Callback to close the modal. */
  onClose: () => void;
  /** Callback invoked on completion to prefill or transition to login. */
  onSuccess: (username: string) => void;
}

/**
 * ForgotPasswordSuccessStep renders Step 4 of password recovery.
 * Informs the user of successful password reset and guides them back to login.
 *
 * @param props - Component props.
 * @returns React component representing Step 4.
 */
export const ForgotPasswordSuccessStep: React.FC<ForgotPasswordSuccessStepProps> = ({
  username,
  onClose,
  onSuccess
}) => {
  const { t } = useTranslation();

  return (
    <div className="space-y-5 text-center py-4">
      <div className="flex justify-center text-green-500">
        <CheckCircle2 size={48} />
      </div>

      <div className="space-y-1">
        <h3 className="text-lg font-bold text-gray-800 dark:text-gray-100">
          {t("auth.resetSuccessTitle", "Password Reset Complete")}
        </h3>
        <p className="text-sm text-gray-500">
          {t(
            "auth.resetSuccessDesc",
            "Your password has been successfully updated. All previous sessions have been signed out."
          )}
        </p>
      </div>

      <Button
        fill
        size="large"
        intent={Intent.PRIMARY}
        onClick={() => {
          onClose();
          onSuccess(username);
        }}
        className="rounded-xl font-bold py-3"
      >
        {t("auth.goToLogin", "Log In with New Password")}
      </Button>
    </div>
  );
};
