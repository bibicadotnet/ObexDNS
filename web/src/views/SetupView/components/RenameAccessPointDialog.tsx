import React from "react";
import { Dialog, Classes, InputGroup, Button, Intent } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import { AP_NAME_REGEX } from "../../../utils/auth";

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
  handleRename,
  isRenaming,
  isValidApName
}) => {
  const { t } = useTranslation();

  const trimmed = renameApName.trim();
  const hasValidLength = trimmed.length >= 1 && trimmed.length <= 30;
  const hasValidChars = trimmed.length > 0 && AP_NAME_REGEX.test(trimmed);
  const isValid = hasValidLength && hasValidChars && isValidApName(renameApName);

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={t("setup.renameAccessPoint")}>
      <div className={Classes.DIALOG_BODY}>
        <div className="w-full block">
          <InputGroup
            autoFocus
            large
            placeholder={t("setup.accessPointName")}
            value={renameApName}
            onChange={(e) => setRenameApName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && isValid && !isRenaming) {
                e.preventDefault();
                handleRename();
              }
            }}
          />
        </div>

        {/* Real-time Access Point Name Format Check */}
        <div className="mt-2.5 flex items-center gap-1.5 text-[11px] font-medium">
          <div className={`flex items-center gap-1 ${hasValidLength ? "text-emerald-600" : "text-gray-400"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${hasValidLength ? "bg-emerald-500" : "bg-gray-300"}`} />
            <span>{t("common.rule1To30Chars", "1 - 30 characters")}</span>
          </div>
        </div>
      </div>
      <div className={Classes.DIALOG_FOOTER}>
        <div className={Classes.DIALOG_FOOTER_ACTIONS}>
          <Button onClick={onClose}>{t("common.cancel", "Cancel")}</Button>
          <Button intent={Intent.PRIMARY} onClick={handleRename} loading={isRenaming} disabled={!isValid}>
            {t("common.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};
