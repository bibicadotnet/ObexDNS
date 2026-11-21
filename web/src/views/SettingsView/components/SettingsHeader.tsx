import React, { useState } from "react";
import { Button, InputGroup, Intent, Tooltip, Position } from "@blueprintjs/core";
import { Download, Edit2, Check, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {  Profile  } from "../types";
import { PROFILE_NAME_REGEX } from "../../../utils/auth";

export interface SettingsHeaderProps {
  profile: Profile | null;
  isEditingName: boolean;
  setIsEditingName: (val: boolean) => void;
  editName: string;
  setEditName: (val: string) => void;
  updateProfileName: () => void;
  exportProfile: () => void;
}

export const SettingsHeader: React.FC<SettingsHeaderProps> = ({
  profile,
  isEditingName,
  setIsEditingName,
  editName,
  setEditName,
  updateProfileName,
  exportProfile,
}) => {
  const { t } = useTranslation();
  const [nameFocused, setNameFocused] = useState(false);

  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <div className="flex flex-col justify-start min-w-0 flex-1 basis-60">
        {isEditingName ? (
          <div className="flex items-center gap-2">
            <Tooltip
              content={t("common.profileNameFormatTip", "Profile Name tip: 1-30 characters, duplicates not allowed")}
              isOpen={nameFocused}
              position={Position.TOP}
              intent={Intent.PRIMARY}
              className="flex-1"
            >
              <div className="w-full block">
                <InputGroup
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onFocus={() => setNameFocused(true)}
                  onBlur={() => setNameFocused(false)}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") updateProfileName();
                    if (e.key === "Escape") {
                      setIsEditingName(false);
                      setEditName(profile?.name || "");
                    }
                  }}
                />
              </div>
            </Tooltip>
            <Button
              icon={<Check size={16} />}
              intent={Intent.SUCCESS}
              minimal
              onClick={updateProfileName}
              disabled={!PROFILE_NAME_REGEX.test(editName)}
            />
            <Button
              icon={<X size={16} />}
              minimal
              onClick={() => {
                setIsEditingName(false);
                setEditName(profile?.name || "");
              }}
            />
          </div>
        ) : (
          <div className="group flex items-center gap-2 cursor-pointer min-w-0" onClick={() => setIsEditingName(true)}>
            <h1 className="page-title min-w-0 break-words">{profile?.name}</h1>
            <Button icon={<Edit2 size={14} />} minimal className="opacity-30 group-hover:opacity-100 transition-opacity" />
          </div>
        )}
        <p className="page-subtitle">{t("settings.subtitle")}</p>
      </div>
      <div className="flex gap-2 items-center">
        <Button icon={<Download size={16} />} text={t("settings.export", "导出配置")} onClick={exportProfile} />
      </div>
    </div>
  );
};
