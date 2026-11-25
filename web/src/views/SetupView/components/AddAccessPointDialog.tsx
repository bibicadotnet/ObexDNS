import React from "react";
import { Dialog, Classes, InputGroup, Button, Intent } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import { AP_NAME_REGEX } from "../../../utils/auth";

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
  handleAdd,
  isAdding,
  isValidApName
}) => {
  const { t } = useTranslation();

  const trimmed = newApName.trim();
  const hasValidLength = trimmed.length >= 1 && trimmed.length <= 30;
  const hasValidChars = trimmed.length > 0 && AP_NAME_REGEX.test(trimmed);
  const isValid = hasValidLength && hasValidChars && isValidApName(newApName);

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={t("setup.addAccessPoint")}>
      <div className={Classes.DIALOG_BODY}>
        <div className="w-full block">
          <InputGroup
            autoFocus
            large
            placeholder={t("setup.accessPointName")}
            value={newApName}
            onChange={(e) => setNewApName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && isValid && !isAdding) {
                e.preventDefault();
                handleAdd();
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
          <Button intent={Intent.PRIMARY} onClick={handleAdd} loading={isAdding} disabled={!isValid}>
            {t("common.create")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};
