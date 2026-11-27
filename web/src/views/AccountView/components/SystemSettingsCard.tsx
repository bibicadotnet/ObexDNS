import React, { useState, useEffect, useRef } from "react";
import {
  Card,
  Elevation,
  H4,
  FormGroup,
  InputGroup,
  Switch,
  Button,
  Intent,
  type OverlayToaster
} from "@blueprintjs/core";
import { Settings } from "lucide-react";
import { useTranslation } from "react-i18next";

import { updateSystemSettings } from "../../../services";
import { executeWithTimeout } from "../../../utils/async";
import { formatApiErrorMessage } from "../../../utils/auth";

export interface SystemSettingsCardProps {
  initialSettings: Record<string, string>;
  onRefresh: () => void;
  onSavingChange?: (saving: boolean) => void;
  toasterRef?: React.RefObject<OverlayToaster | null>;
}

export const SystemSettingsCard: React.FC<SystemSettingsCardProps> = ({
  initialSettings,
  onRefresh,
  onSavingChange,
  toasterRef,
}) => {
  const { t } = useTranslation();

  // Controlled fields (never overwritten by refresh once user has typed)
  const [siteKey, setSiteKey] = useState(initialSettings.turnstile_site_key || "");
  // Secret key is NOT populated from server (server redacts it). Track whether user has typed a new one.
  const [secretKey, setSecretKey] = useState("");
  const [enabledSignup, setEnabledSignup] = useState(initialSettings.turnstile_enabled_signup === "true");
  const [enabledLogin, setEnabledLogin] = useState(initialSettings.turnstile_enabled_login === "true");

  const [sysLoading, setSysLoading] = useState(false);
  const [showTurnstileSecretKey, setShowTurnstileSecretKey] = useState(false);

  // Track initialSettings reference so we only sync toggles on external refresh,
  // not when the user is actively editing.
  const prevInitialRef = useRef(initialSettings);
  useEffect(() => {
    if (initialSettings === prevInitialRef.current) return;
    prevInitialRef.current = initialSettings;
    // Only sync the non-secret fields (site key and toggles) from the server
    setSiteKey(initialSettings.turnstile_site_key || "");
    setEnabledSignup(initialSettings.turnstile_enabled_signup === "true");
    setEnabledLogin(initialSettings.turnstile_enabled_login === "true");
    // Secret key is never populated from server — leave whatever the user typed
  }, [initialSettings]);

  const handleSaveSysSettings = async () => {
    setSysLoading(true);
    onSavingChange?.(true);
    try {
      const payload: Record<string, string> = {
        turnstile_site_key: siteKey,
        turnstile_enabled_signup: String(enabledSignup),
        turnstile_enabled_login: String(enabledLogin),
      };
      // Only include secret_key in the payload when the user has actually typed something.
      // Sending an empty string would erase the stored secret.
      if (secretKey.trim()) {
        payload.turnstile_secret_key = secretKey.trim();
      }
      await executeWithTimeout(updateSystemSettings(payload), 10000);
      toasterRef?.current?.show({
        message: t("common.saveSuccess", "Saved successfully"),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
      // Clear the secret field after a successful save (it will never come back from server)
      setSecretKey("");
      onRefresh();
    } catch (e: any) {
      console.error(e);
      toasterRef?.current?.show({
        message: formatApiErrorMessage(e, t),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setSysLoading(false);
      onSavingChange?.(false);
    }
  };

  return (
    <Card elevation={Elevation.ONE} className="p-5 sm:p-6 rounded-2xl bg-white border border-[#d0d7de] shadow-xs space-y-5">
      <div className="flex items-center gap-2">
        <Settings size={20} className="text-gray-500" />
        <H4 className="section-title m-0">{t("account.systemSettings", "System Settings")}</H4>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
        <div className="space-y-4">
          <H4 className="subsection-title opacity-70 text-blue-500">Cloudflare Turnstile</H4>
          <FormGroup label="Site Key">
            <InputGroup
              value={siteKey}
              onChange={(e) => setSiteKey(e.target.value)}
              placeholder="0x000..."
            />
          </FormGroup>
          <FormGroup
            label="Secret Key"
            helperText={t("account.turnstileSecretKeyHelp", "Leave blank to keep the existing secret unchanged.")}
          >
            <InputGroup
              type={showTurnstileSecretKey ? "text" : "password"}
              value={secretKey}
              onChange={(e) => setSecretKey(e.target.value)}
              placeholder={t("account.turnstileSecretKeyPlaceholder", "Enter new secret key to change…")}
              rightElement={
                <Button
                  minimal={true}
                  icon={showTurnstileSecretKey ? "eye-open" : "eye-off"}
                  onClick={() => setShowTurnstileSecretKey(!showTurnstileSecretKey)}
                  title={showTurnstileSecretKey ? t("auth.hidePassword", "Hide password") : t("auth.showPassword", "Show password")}
                />
              }
            />
          </FormGroup>
        </div>

        <div className="space-y-4">
          <H4 className="subsection-title opacity-70 text-green-500">
            {t("account.featureToggle", "Feature Toggle")}
          </H4>
          <Switch
            label={t("account.enableTurnstileSignup", "Enable verification on Signup")}
            checked={enabledSignup}
            onChange={(e) => setEnabledSignup(e.currentTarget.checked)}
          />
          <Switch
            label={t("account.enableTurnstileLogin", "Enable verification on Login")}
            checked={enabledLogin}
            onChange={(e) => setEnabledLogin(e.currentTarget.checked)}
          />
        </div>
      </div>

      <div className="flex justify-end pt-2">
        <Button
          intent={Intent.PRIMARY}
          icon="floppy-disk"
          text={t("common.save", "Save")}
          loading={sysLoading}
          onClick={handleSaveSysSettings}
          className="rounded-lg! font-semibold"
        />
      </div>
    </Card>
  );
};
