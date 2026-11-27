import React from "react";
import { FormGroup, InputGroup, Button, Intent } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";

/**
 * Props for the ForgotPasswordUsernameStep component.
 */
export interface ForgotPasswordUsernameStepProps {
  /** Current username input value. */
  username: string;
  /** Callback to update the username. */
  setUsername: (val: string) => void;
  /** Whether Turnstile challenge is enabled. */
  isTurnstileEnabled: boolean | undefined;
  /** Ref pointing to the Turnstile container div. */
  turnstileRef: React.RefObject<HTMLDivElement | null>;
  /** Indicates if Turnstile has rendered a visible widget (managed/challenge). */
  hasVisibleWidget?: boolean;
  /** Turnstile verification status. */
  turnstileStatus: "idle" | "verifying" | "success" | "error";
  /** Resolved Turnstile response token. */
  turnstileToken: string | null;
  /** Whether Step 1 submission is in progress. */
  loading: boolean;
  /** Callback to handle the form submission. */
  onSubmit: (e: React.FormEvent) => void;
  /** Callback to cancel and close the modal. */
  onCancel: () => void;
}

/**
 * ForgotPasswordUsernameStep renders the first step of password recovery.
 * Captures the username and renders the Turnstile bot verification widget.
 *
 * @param props - Component props.
 * @returns React component representing Step 1.
 */
export const ForgotPasswordUsernameStep: React.FC<ForgotPasswordUsernameStepProps> = ({
  username,
  setUsername,
  isTurnstileEnabled,
  turnstileRef,
  hasVisibleWidget,
  turnstileStatus,
  turnstileToken,
  loading,
  onSubmit,
  onCancel
}) => {
  const { t } = useTranslation();

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <p className="text-sm text-gray-500">
        {t(
          "auth.forgotPasswordDesc",
          "Enter your username to begin identity verification."
        )}
      </p>

      <FormGroup label={t("auth.username")} labelFor="forgot-username">
        <InputGroup
          id="forgot-username"
          leftIcon="user"
          placeholder={t("auth.usernamePlaceholder")}
          size="large"
          className="rounded-xl"
          value={username}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setUsername(e.target.value)
          }
          autoFocus
          required
        />
      </FormGroup>

      {isTurnstileEnabled && (
        <div
          className={`flex justify-center transition-all duration-200 ${
            hasVisibleWidget
              ? "my-2 min-h-[65px]"
              : "h-0 overflow-hidden [&:has(iframe:not([style*='height: 0px']))]:my-2 [&:has(iframe:not([style*='height: 0px']))]:min-h-[65px]"
          }`}
        >
          <div ref={turnstileRef} />
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button minimal text={t("common.cancel", "Cancel")} onClick={onCancel} />
        <Button
          intent={Intent.PRIMARY}
          type="submit"
          loading={loading || turnstileStatus === "verifying"}
          disabled={Boolean(isTurnstileEnabled && !turnstileToken)}
          text={t("common.continue", "Continue")}
        />
      </div>
    </form>
  );
};
