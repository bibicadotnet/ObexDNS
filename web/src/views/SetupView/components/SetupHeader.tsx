import React from "react";
import { useTranslation } from "react-i18next";
import { DeploymentModeBadge } from "../../../components/DeploymentMode";
import { PageHeader } from "../../../components/PageHeader";

export interface SetupHeaderProps {
  isMobile?: boolean;
}

export const SetupHeader: React.FC<SetupHeaderProps> = () => {
  const { t } = useTranslation();

  return (
    <PageHeader
      className="mb-0"
      title={t("setup.title")}
      subtitle={t("setup.subtitle")}
      actions={<DeploymentModeBadge />}
    />
  );
};
