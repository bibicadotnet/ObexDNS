import React from "react";
import { Dialog, Classes, Tooltip, InputGroup, Button, Intent, Position } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";

export interface RenameAccessPointDialogProps {
  isOpen: boolean;
  onClose: () => void;
  renameApName: string;
  setRenameApName: (val: string) => void;
  renameApNameFocused: boolean;
  setRenameApNameFocused: (val: boolean) => void;
  handleRename: () => void;
  isRenaming: boolean;
  isValidApName: (name: string) => boolean;
}

export const RenameAccessPointDialog: React.FC<RenameAccessPointDialogProps> = ({
  isOpen,
  onClose,
  renameApName,
  setRenameApName,
  renameApNameFocused,
  setRenameApNameFocused,
  handleRename,
  isRenaming,
  isValidApName
}) => {
  const { t } = useTranslation();

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={t("setup.renameAccessPoint")}>
      <div className={Classes.DIALOG_BODY}>
        <Tooltip
          content={t("setup.accessPointNameFormatTip", "1-30 characters, letters, numbers, hyphens and underscores allowed")}
          isOpen={renameApNameFocused}
          position={Position.TOP}
          intent={Intent.PRIMARY}
          className="w-full"
        >
          <div className="w-full block">
            <InputGroup
              autoFocus
              large
              placeholder={t("setup.accessPointName")}
              value={renameApName}
              onChange={(e) => setRenameApName(e.target.value)}
              onFocus={() => setRenameApNameFocused(true)}
              onBlur={() => setRenameApNameFocused(false)}
            />
          </div>
        </Tooltip>
      </div>
      <div className={Classes.DIALOG_FOOTER}>
        <div className={Classes.DIALOG_FOOTER_ACTIONS}>
          <Button onClick={onClose}>{t("common.cancel", "Cancel")}</Button>
          <Button intent={Intent.PRIMARY} onClick={handleRename} loading={isRenaming} disabled={!isValidApName(renameApName)}>
            {t("common.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};
