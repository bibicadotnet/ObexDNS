import React from "react";
import {
  Button,
  FormGroup,
  Callout,
  Intent,
  Card,
  Elevation,
  Tag
} from "@blueprintjs/core";
import { Key, Smartphone, ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { QRCodeCanvas } from "../../views/AccountView/components/QRCodeCanvas";
import { DigitInput } from "../DigitInput";

export interface SignupMfaStepProps {
  mfaChoice: "choose" | "totp";
  setMfaChoice: (choice: "choose" | "totp") => void;
  onRegisterPasskey: () => void;
  passkeyRegLoading: boolean;
  passkeyRegError: string;
  onStartTotp: () => void;
  totpSetupData: { secret: string; uri: string } | null;
  totpSetupToken: string;
  setTotpSetupToken: (val: string) => void;
  totpSetupError: string;
  totpSetupLoading: boolean;
  onTotpSubmit: (e: React.FormEvent) => void;
  onSkip: () => void;
}

export const SignupMfaStep: React.FC<SignupMfaStepProps> = ({
  mfaChoice,
  setMfaChoice,
  onRegisterPasskey,
  passkeyRegLoading,
  passkeyRegError,
  onStartTotp,
  totpSetupData,
  totpSetupToken,
  setTotpSetupToken,
  totpSetupError,
  totpSetupLoading,
  onTotpSubmit,
  onSkip
}) => {
  const { t } = useTranslation();

  // Mode 1: Choice view (Passkey vs TOTP)
  if (mfaChoice === "choose") {
    return (
      <div className="space-y-4">
        {passkeyRegError && (
          <Callout intent={Intent.DANGER} className="rounded-xl">
            {passkeyRegError}
          </Callout>
        )}

        <div className="space-y-3">
          {/* Passkey Card */}
          <Card
            elevation={Elevation.ONE}
            className="p-4 rounded-xl border border-blue-100 hover:border-blue-300 transition-colors cursor-pointer"
            onClick={!passkeyRegLoading ? onRegisterPasskey : undefined}
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-blue-50 text-blue-600 rounded-xl">
                  <Key size={24} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-bold text-gray-800 m-0">
                      {t("account.passkey.title", "Passkeys")}
                    </h4>
                    <Tag intent={Intent.PRIMARY} minimal round>
                      {t("auth.mfaRecommended", "Recommended")}
                    </Tag>
                  </div>
                  <div className="text-xs text-blue-600 font-mono mt-0.5">
                    {window.location.hostname}
                  </div>
                  <p className="text-xs text-gray-500 mt-1 mb-0 leading-relaxed">
                    {t("auth.passkeySignupDesc", "Use Touch ID, Face ID, Windows Hello, or a security key. Lightning-fast and phishing-resistant."
                    )}
                  </p>
                </div>
              </div>
            </div>
            <div className="mt-3 text-right">
              <Button
                intent={Intent.PRIMARY}
                loading={passkeyRegLoading}
                text={t("auth.bindPasskeyNow", "Register Passkey Now")}
                className="rounded-lg font-medium"
              />
            </div>
          </Card>

          {/* TOTP Card */}
          <Card
            elevation={Elevation.ONE}
            className="p-4 rounded-xl border border-gray-100 hover:border-gray-300 transition-colors cursor-pointer"
            onClick={onStartTotp}
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-purple-50 text-purple-600 rounded-xl">
                  <Smartphone size={24} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-bold text-gray-800 m-0">
                      {t("auth.mfaMethodTotp", "Authenticator App (TOTP)")}
                    </h4>
                    <Tag intent={Intent.NONE} minimal round>
                      {t("auth.mfaUniversal", "Universal")}
                    </Tag>
                  </div>
                  <p className="text-xs text-gray-500 mt-1 mb-0 leading-relaxed">
                    {t("account.totp.setupDesc", "Add an extra layer of security to your account. Use Google Authenticator, Authy, or any TOTP-compatible app."
                    )}
                  </p>
                </div>
              </div>
            </div>
            <div className="mt-3 text-right">
              <Button
                minimal
                text={t("auth.setupTotpBtn", "Set Up Authenticator App")}
                className="rounded-lg font-medium text-gray-700"
              />
            </div>
          </Card>
        </div>

        <div className="text-center pt-2">
          <Button
            minimal
            text={t("auth.skipMfaSetup", "Skip for now, complete signup")}
            onClick={onSkip}
            className="text-xs text-gray-400 hover:text-gray-600"
          />
        </div>
      </div>
    );
  }

  // Mode 2: TOTP Setup view
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setMfaChoice("choose")}
          className="text-xs text-blue-600 hover:underline flex items-center gap-1 bg-transparent border-none cursor-pointer p-0"
        >
          <ArrowLeft size={14} />
          <span>{t("auth.backToMfaOptions", "Back to options")}</span>
        </button>
      </div>

      {totpSetupData && (
        <div className="flex flex-col items-center gap-3">
          <QRCodeCanvas uri={totpSetupData.uri} />
          <div className="text-center">
            <p className="text-xs text-gray-500 mb-1">
              {t("account.totp.orEnterManually", "Or enter the key manually:")}
            </p>
            <code className="text-xs font-mono bg-gray-100 px-2 py-1 rounded select-all">
              {totpSetupData.secret}
            </code>
          </div>
        </div>
      )}

      {totpSetupError && (
        <Callout intent={Intent.DANGER} className="rounded-xl">
          {totpSetupError}
        </Callout>
      )}

      <form onSubmit={onTotpSubmit} className="space-y-4">
        <FormGroup
          label={t("account.totp.enterCode", "Enter the 6-digit code:")}
          helperText={t(
            "account.totp.enterCodeHint",
            "Enter the 6-digit code to confirm."
          )}
        >
          <DigitInput
            length={6}
            value={totpSetupToken}
            onChange={setTotpSetupToken}
            disabled={totpSetupLoading}
            autoFocus
          />
        </FormGroup>

        <Button
          fill
          size="large"
          intent={Intent.PRIMARY}
          type="submit"
          loading={totpSetupLoading}
          disabled={totpSetupToken.length !== 6}
          className="rounded-xl font-bold py-3"
        >
          {t("account.totp.activate", "Activate")}
        </Button>
      </form>
    </div>
  );
};
