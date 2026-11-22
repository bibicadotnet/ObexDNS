import React, { useEffect, useState } from "react";
import { Card, Elevation, H5, FormGroup, Switch, InputGroup, Intent } from "@blueprintjs/core";
import { Globe } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {  ProfileSettings  } from "../types";
import { checkEcsSubnet } from "../../../utils/ecs";

export interface AdvancedEcsCardProps {
  settings: ProfileSettings;
  setSettings: (settings: ProfileSettings) => void;
}

export const AdvancedEcsCard: React.FC<AdvancedEcsCardProps> = ({ settings, setSettings }) => {
  const { t } = useTranslation();
  const ecs = settings.ecs;

  // "Custom subnet" is a UI mode until a valid subnet exists: switching it on must not save anything,
  // otherwise the profile would be stored as "custom subnet" with no subnet at all.
  const [customMode, setCustomMode] = useState(!ecs.use_client_ip);
  useEffect(() => {
    setCustomMode(!ecs.use_client_ip);
  }, [ecs.use_client_ip]);

  // Text fields are drafts; they are validated and committed on Enter / blur only.
  const [v4, setV4] = useState(ecs.ipv4_cidr || "");
  const [v6, setV6] = useState(ecs.ipv6_cidr || "");
  useEffect(() => setV4(ecs.ipv4_cidr || ""), [ecs.ipv4_cidr]);
  useEffect(() => setV6(ecs.ipv6_cidr || ""), [ecs.ipv6_cidr]);

  const [errors, setErrors] = useState<{ v4: boolean; v6: boolean; none: boolean }>({
    v4: false,
    v6: false,
    none: false,
  });

  const fieldsEnabled = ecs.enabled && customMode;

  const handleCustomToggle = (checked: boolean) => {
    setCustomMode(checked);
    if (!checked) {
      setErrors({ v4: false, v6: false, none: false });
      setSettings({ ...settings, ecs: { ...ecs, use_client_ip: true } });
      return;
    }
    // ON: validate the values currently in the fields. Valid -> saved and used; invalid -> error, nothing saved.
    commitFields(v4, v6);
  };

  const commitFields = (raw4: string, raw6: string, reportEmpty = true) => {
    const c4 = checkEcsSubnet(raw4, 4);
    const c6 = checkEcsSubnet(raw6, 6);
    const none = c4.ok && c6.ok && !c4.value && !c6.value;
    // Merely tabbing through an empty field (blur) must not nag; Enter does.
    setErrors({ v4: !c4.ok, v6: !c6.ok, none: none && reportEmpty });
    if (!c4.ok || !c6.ok || none) return;

    // Show the normalised form (e.g. "1.2.3.4" -> "1.2.3.4/24").
    setV4(c4.value);
    setV6(c6.value);

    const unchanged =
      !ecs.use_client_ip && c4.value === (ecs.ipv4_cidr || "") && c6.value === (ecs.ipv6_cidr || "");
    if (unchanged) return;

    setSettings({
      ...settings,
      ecs: {
        ...ecs,
        use_client_ip: false,
        ipv4_cidr: c4.value || undefined,
        ipv6_cidr: c6.value || undefined,
      },
    });
  };

  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitFields(v4, v6);
    }
  };

  return (
    <Card elevation={Elevation.ONE} className="h-full min-w-0 ">
      <div className="flex items-center justify-between min-h-[30px] mb-4">
        <H5 className="section-title flex items-center gap-2 m-0">
          <Globe size={18} className="text-orange-500" /> {t("settings.ecsTitle")}
        </H5>
      </div>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-6">
          <Switch
            label={t("settings.sendEcs")}
            checked={ecs.enabled}
            className="mb-0!"
            onChange={(e) =>
              setSettings({
                ...settings,
                ecs: { ...ecs, enabled: e.currentTarget.checked },
              })
            }
          />
          <Switch
            label={t("settings.customSubnet")}
            disabled={!ecs.enabled}
            checked={customMode}
            className="mb-0!"
            onChange={(e) => handleCustomToggle(e.currentTarget.checked)}
          />
        </div>

        <div className="space-y-3 pt-2 border-t border-gray-100 ">
          <FormGroup
            label={t("settings.customIpv4")}
            labelInfo={t("settings.ipv4Hint")}
            disabled={!fieldsEnabled}
            intent={errors.v4 ? Intent.DANGER : Intent.NONE}
            helperText={
              errors.v4
                ? t("settings.ecsInvalidIpv4", "Invalid IPv4 subnet. Example: 1.2.3.4 or 1.2.3.0/24")
                : undefined
            }
          >
            <InputGroup
              placeholder="1.2.3.4"
              value={v4}
              disabled={!fieldsEnabled}
              intent={errors.v4 ? Intent.DANGER : Intent.NONE}
              onChange={(e) => {
                setV4(e.target.value);
                if (errors.v4 || errors.none) setErrors((prev) => ({ ...prev, v4: false, none: false }));
              }}
              onBlur={() => commitFields(v4, v6, false)}
              onKeyDown={onEnter}
            />
          </FormGroup>
          <FormGroup
            label={t("settings.customIpv6")}
            labelInfo={t("settings.ipv6Hint")}
            disabled={!fieldsEnabled}
            intent={errors.v6 ? Intent.DANGER : Intent.NONE}
            helperText={
              errors.v6
                ? t("settings.ecsInvalidIpv6", "Invalid IPv6 subnet. Example: 2001:db8:: or 2001:db8::/32")
                : undefined
            }
          >
            <InputGroup
              placeholder="2001:db8::"
              value={v6}
              disabled={!fieldsEnabled}
              intent={errors.v6 ? Intent.DANGER : Intent.NONE}
              onChange={(e) => {
                setV6(e.target.value);
                if (errors.v6 || errors.none) setErrors((prev) => ({ ...prev, v6: false, none: false }));
              }}
              onBlur={() => commitFields(v4, v6, false)}
              onKeyDown={onEnter}
            />
          </FormGroup>
          {errors.none && (
            <p className="text-xs text-red-500">
              {t("settings.ecsSubnetRequired", "Enter an IPv4 and/or IPv6 subnet to use a custom subnet.")}
            </p>
          )}
        </div>
        <p className="text-xs opacity-60">{t("settings.ecsUpstreamHint")}</p>
      </div>
    </Card>
  );
};
