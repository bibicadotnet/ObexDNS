import React from "react";
import { FormGroup, InputGroup, Button, Intent } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";

/**
 * Props for the ForgotPasswordNewPasswordStep component.
 */
export interface ForgotPasswordNewPasswordStepProps {
  /** Current new password value. */
  newPassword: string;
  /** Callback to update new password value. */
  setNewPassword: (val: string) => void;
  /** Current confirmation password value. */
  confirmPassword: string;
  /** Callback to update confirmation password value. */
  setConfirmPassword: (val: string) => void;
  /** Whether the password inputs are visible as plain text. */
  showPassword: boolean;
  /** Callback to toggle password visibility. */
  setShowPassword: (val: boolean) => void;
  /** Whether submission is actively running. */
  loading: boolean;
  /** Callback to handle form submission. */
  onSubmit: (e: React.FormEvent) => void;
  /** Callback to cancel and close the modal. */
  onCancel: () => void;
}

/**
 * ForgotPasswordNewPasswordStep renders Step 3 of password recovery.
 * Captures and validates the new password and confirmation password.
 *
 * @param props - Component props.
 * @returns React component representing Step 3.
 */
export const ForgotPasswordNewPasswordStep: React.FC<ForgotPasswordNewPasswordStepProps> = ({
  newPassword,
  setNewPassword,
  confirmPassword,
  setConfirmPassword,
  showPassword,
  setShowPassword,
  loading,
  onSubmit,
  onCancel
}) => {
  const { t } = useTranslation();

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <p className="text-sm text-gray-500">
        {t(
          "auth.setNewPasswordDesc",
          "Identity verified. Please set your new account password."
        )}
      </p>

      <FormGroup label={t("account.newPassword")} labelFor="forgot-new-password">
        <InputGroup
          id="forgot-new-password"
          leftIcon="lock"
          type={showPassword ? "text" : "password"}
          placeholder={t("auth.formatTipPassword")}
          size="large"
          className="rounded-xl"
          value={newPassword}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setNewPassword(e.target.value)
          }
          autoFocus
          required
          rightElement={
            <Button
              minimal
              icon={showPassword ? "eye-open" : "eye-off"}
              onClick={() => setShowPassword(!showPassword)}
            />
          }
        />
      </FormGroup>

      <FormGroup
        label={t("auth.confirmNewPassword", "Confirm New Password")}
        labelFor="forgot-confirm-password"
      >
        <InputGroup
          id="forgot-confirm-password"
          leftIcon="lock"
          type={showPassword ? "text" : "password"}
          placeholder={t("auth.formatTipPassword")}
          size="large"
          className="rounded-xl"
          value={confirmPassword}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setConfirmPassword(e.target.value)
          }
          required
        />
      </FormGroup>

      <div className="flex justify-end gap-2 pt-2">
        <Button minimal text={t("common.cancel", "Cancel")} onClick={onCancel} />
        <Button
          intent={Intent.PRIMARY}
          type="submit"
          loading={loading}
          text={t("account.updatePassword", "Update Password")}
        />
      </div>
    </form>
  );
};
