import React from "react";
import { Dialog, Classes, InputGroup, Button, Intent } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import { PROFILE_NAME_REGEX } from "../../../utils/auth";
import type { Profile } from "../../../types/auth";

export interface RenameProfileDialogProps {
  isOpen: boolean;
  onClose: () => void;
  profile: Profile | null;
  name: string;
  setName: (val: string) => void;
  isDefault: boolean;
  setIsDefault: (val: boolean) => void;
  onSave: () => void;
  loading: boolean;
  canToggleDefault: boolean;
}

export const RenameProfileDialog: React.FC<RenameProfileDialogProps> = ({
  isOpen,
  onClose,
  profile: _profile,
  name,
  setName,
  isDefault,
  setIsDefault,
  onSave,
  loading,
  canToggleDefault,
}) => {
  const { t } = useTranslation();

  const trimmed = name.trim();
  const hasValidLength = trimmed.length >= 1 && trimmed.length <= 30;
  const hasValidChars = trimmed.length > 0 && PROFILE_NAME_REGEX.test(trimmed);
  const isValid = hasValidLength && hasValidChars;

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={t("common.renameProfile", "Rename Profile")}>
      <div className={Classes.DIALOG_BODY}>
        <div className="w-full block">
          <InputGroup
            autoFocus
            large
            placeholder={t("common.profileName", "Profile Name")}
            value={name}
            disabled={loading}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && isValid && !loading) {
                e.preventDefault();
                onSave();
              }
            }}
          />
        </div>

        {/* Real-time Profile Name Format Check */}
        <div className="mt-2.5 flex items-center gap-1.5 text-[11px] font-medium">
          <div className={`flex items-center gap-1 ${hasValidLength ? "text-emerald-600" : "text-gray-400"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${hasValidLength ? "bg-emerald-500" : "bg-gray-300"}`} />
            <span>{t("common.rule1To30Chars", "1 - 30 characters")}</span>
          </div>
        </div>

        <div className="mt-4 pt-3 border-t border-gray-100">
          <label className={`flex items-center gap-2 text-xs text-gray-700 select-none ${canToggleDefault ? "cursor-pointer" : "opacity-60 cursor-not-allowed"}`}>
            <input
              type="checkbox"
              checked={isDefault}
              disabled={loading || !canToggleDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer disabled:cursor-not-allowed"
            />
            <span className="font-medium">{t("common.setAsDefault", "Set as default")}</span>
          </label>
        </div>
      </div>
      <div className={Classes.DIALOG_FOOTER}>
        <div className={Classes.DIALOG_FOOTER_ACTIONS}>
          <Button onClick={onClose} disabled={loading}>{t("common.cancel", "Cancel")}</Button>
          <Button
            intent={Intent.PRIMARY}
            onClick={onSave}
            loading={loading}
            disabled={!isValid}
          >
            {t("common.save", "Save")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};
