import React, { useEffect, useState } from "react";
import { Card, Elevation, H5, FormGroup, InputGroup, Button, PopoverNext, Menu, MenuItem } from "@blueprintjs/core";
import { Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {  ProfileSettings  } from "../types";
import { usePresetUpstreams } from "../hooks";

export interface UpstreamCardProps {
  settings: ProfileSettings;
  setSettings: (settings: ProfileSettings) => void;
}

export const UpstreamCard: React.FC<UpstreamCardProps> = ({ settings, setSettings }) => {
  const { t } = useTranslation();
  const PRESET_UPSTREAMS = usePresetUpstreams();

  // Typing must not save anything: the value is only committed (and verified by the server)
  // on Enter / blur / preset pick. The draft re-syncs when the saved value changes (incl. rollback on failure).
  const committed = settings.upstream?.[0] || "";
  const [draft, setDraft] = useState(committed);
  useEffect(() => {
    setDraft(committed);
  }, [committed]);

  const commit = (raw: string) => {
    const value = raw.trim();
    if (!value || value === committed) {
      setDraft(committed);
      return;
    }
    setDraft(value);
    setSettings({ ...settings, upstream: [value] });
  };

  const upstreamMenu = (
    <Menu className="min-w-96">
      {PRESET_UPSTREAMS.map((preset, i) => (
        <MenuItem
          key={i}
          text={preset.label}
          onClick={() => commit(preset.url)}
          labelElement={
            <div className="flex flex-col items-end text-right">
              <span className="text-[9px] opacity-85 max-w-64 truncate" title={preset.url}>
                {preset.url}
              </span>
            </div>
          }
        />
      ))}
    </Menu>
  );

  return (
    <Card elevation={Elevation.ONE} className="dark:bg-gray-900 dark:border-gray-800">
      <H5 className="flex items-center gap-2 mb-4 font-bold">
        <Server size={18} className="text-blue-500" /> {t("settings.upstreamTitle")}
      </H5>
      <FormGroup label={`DoH (https://) / DoT (tls://) / DNS Stamp (sdns://) / ${t("settings.classicDns")}`}>
        <InputGroup
          fill
          placeholder="https://... | tls://... | sdns://... | 1.1.1.1"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit(draft);
            } else if (e.key === "Escape") {
              setDraft(committed);
            }
          }}
          onFocus={(e) => e.target.select()}
          rightElement={
            <PopoverNext content={upstreamMenu} placement="bottom-end" animation="minimal" arrow={false}>
              <Button variant="minimal" icon="chevron-down" />
            </PopoverNext>
          }
        />
      </FormGroup>
      <p className="text-xs opacity-60">{t("settings.upstreamDesc")}</p>
    </Card>
  );
};
