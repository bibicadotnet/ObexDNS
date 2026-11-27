import React from "react";
import { Button } from "@blueprintjs/core";
import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../../../components/PageHeader";
import type { Profile } from "../types";

export interface SettingsHeaderProps {
  profile?: Profile | null;
  isEditingName?: boolean;
  setIsEditingName?: (val: boolean) => void;
  editName?: string;
  setEditName?: (val: string) => void;
  editIsDefault?: boolean;
  setEditIsDefault?: (val: boolean) => void;
  updateProfileName?: () => void;
  exportProfile: () => void;
}

export const SettingsHeader: React.FC<SettingsHeaderProps> = ({
  exportProfile,
}) => {
  const { t } = useTranslation();

  return (
    <PageHeader
      title={t("settings.title", "Settings")}
      subtitle={t("settings.subtitle")}
      actions={
        <Button
          icon={<Download size={16} />}
          text={t("settings.export", "Export Config")}
          onClick={exportProfile}
        />
      }
    />
  );
};
