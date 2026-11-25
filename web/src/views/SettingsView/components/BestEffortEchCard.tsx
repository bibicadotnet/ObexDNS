import React from "react";
import {
  Card,
  Elevation,
  H5,
  Switch,
  Button,
  PopoverNext,
  Intent,
} from "@blueprintjs/core";
import { Lock, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ProfileSettings } from "../types";

export interface BestEffortEchCardProps {
  settings: ProfileSettings;
  setSettings: (settings: ProfileSettings) => void;
}

export const BestEffortEchCard: React.FC<BestEffortEchCardProps> = ({ settings, setSettings }) => {
  const { t } = useTranslation();
  const isEnabled = typeof settings.best_effort_ech === "boolean"
    ? settings.best_effort_ech
    : !!settings.best_effort_ech?.enabled;

  // Only the on/off flag is user-controlled. The outer SNI (fronting domain) and the ECHConfig it is
  // embedded in are managed by the server, so they are intentionally not editable here.
  const handleToggle = (checked: boolean) => {
    setSettings({
      ...settings,
      best_effort_ech: { enabled: checked },
    });
  };

  return (
    <Card elevation={Elevation.ONE} className="h-full min-w-0">
      <div className="flex items-center justify-between min-h-[30px] mb-4">
        <H5 className="section-title flex items-center gap-2 m-0 text-purple-600">
          <Lock size={18} /> {t("settings.echTitle")}
        </H5>
        <PopoverNext
          placement="bottom-end"
          usePortal={true}
          content={
            <div className="p-4 max-w-sm">
              <H5>{t("settings.whatIsEch", "What is ECH (Encrypted Client Hello)?")}</H5>
              <p className="text-sm mb-2">
                {t("settings.echHelpDesc")}
              </p>
              <ul className="list-disc list-inside text-sm opacity-80 mb-3 space-y-1">
                <li>{t("settings.echHelpBenefit1")}</li>
                <li>{t("settings.echHelpBenefit2")}</li>
              </ul>
              <div className="text-xs border-t border-gray-100 pt-2">
                <a
                  href="https://en.wikipedia.org/wiki/Encrypted_Client_Hello"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-blue-500 hover:underline"
                >
                  <ExternalLink size={10} /> {t("setup.learnMore", "Learn more")}
                </a>
              </div>
            </div>
          }
        >
          <Button icon="help" variant="minimal" intent={Intent.NONE} />
        </PopoverNext>
      </div>

      <div className="space-y-4">
        <Switch
          label={t("settings.enableEch", "Enable ECH Rewrite")}
          checked={isEnabled}
          onChange={(e) => handleToggle(e.currentTarget.checked)}
        />
        <p className="text-xs opacity-60 leading-relaxed">
          {t("settings.echDesc", "For domains proxied by Cloudflare, automatically rewrite and inject ECH parameters when querying HTTPS (Type 65) or SVCB (Type 64) records if upstream did not configure ECH, to protect SNI privacy."
          )}
        </p>
        <p className="text-xs opacity-60 leading-relaxed">
          {t(
            "settings.echServerManaged",
            "The ECH configuration and outer SNI are managed by the server and cannot be changed per profile."
          )}
        </p>
      </div>
    </Card>
  );
};
