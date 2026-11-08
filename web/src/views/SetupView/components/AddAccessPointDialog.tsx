import React from "react";
import { Dialog, Classes, Tooltip, InputGroup, Button, Intent, Position } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";

export interface AddAccessPointDialogProps {
  isOpen: boolean;
  onClose: () => void;
  newApName: string;
  setNewApName: (val: string) => void;
  newApNameFocused: boolean;
  setNewApNameFocused: (val: boolean) => void;
  handleAdd: () => void;
  isAdding: boolean;
  isValidApName: (name: string) => boolean;
}

export const AddAccessPointDialog: React.FC<AddAccessPointDialogProps> = ({
  isOpen,
  onClose,
  newApName,
  setNewApName,
  newApNameFocused,
  setNewApNameFocused,
  handleAdd,
  isAdding,
  isValidApName
}) => {
  const { t } = useTranslation();

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={t("setup.addAccessPoint")}>
      <div className={Classes.DIALOG_BODY}>
        <Tooltip
          content={t("setup.accessPointNameFormatTip", "1-30 characters, letters, numbers, hyphens and underscores allowed")}
          isOpen={newApNameFocused}
          position={Position.TOP}
          intent={Intent.PRIMARY}
          className="w-full"
        >
          <div className="w-full block">
            <InputGroup
              autoFocus
              large
              placeholder={t("setup.accessPointName")}
              value={newApName}
              onChange={(e) => setNewApName(e.target.value)}
              onFocus={() => setNewApNameFocused(true)}
              onBlur={() => setNewApNameFocused(false)}
            />
          </div>
        </Tooltip>
      </div>
      <div className={Classes.DIALOG_FOOTER}>
        <div className={Classes.DIALOG_FOOTER_ACTIONS}>
          <Button onClick={onClose}>{t("common.cancel", "Cancel")}</Button>
          <Button intent={Intent.PRIMARY} onClick={handleAdd} loading={isAdding} disabled={!isValidApName(newApName)}>
            {t("common.create")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};
