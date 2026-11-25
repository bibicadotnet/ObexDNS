import React, { useState, useEffect } from "react";
import { Dialog, Classes, Button, Intent } from "@blueprintjs/core";
import { AlertTriangle, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AccessPoint } from "../../../types/auth";

export interface DeleteAccessPointDialogProps {
  isOpen: boolean;
  onClose: () => void;
  ap: AccessPoint | null;
  otherAps: AccessPoint[];
  onConfirm: (replacementApId?: string) => Promise<void>;
}

export const DeleteAccessPointDialog: React.FC<DeleteAccessPointDialogProps> = ({
  isOpen,
  onClose,
  ap,
  otherAps,
  onConfirm,
}) => {
  const { t } = useTranslation();
  const [selectedReplacementId, setSelectedReplacementId] = useState<string>(
    otherAps[0]?.id || ""
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (otherAps.length > 0 && !otherAps.some((a) => a.id === selectedReplacementId)) {
      setSelectedReplacementId(otherAps[0].id);
    }
  }, [otherAps, selectedReplacementId]);

  if (!ap) return null;

  const isDefault = Boolean(ap.is_default);

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await onConfirm(isDefault ? selectedReplacementId : undefined);
      onClose();
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={
        isDefault
          ? t("setup.deleteDefaultApTitle", "Delete Default Access Point")
          : t("setup.deleteAccessPointTitle", "Delete Access Point")
      }
      canOutsideClickClose={!loading}
    >
      <div className={Classes.DIALOG_BODY}>
        <div className="flex items-start gap-3 mb-4">
          <div
            className={`p-2.5 rounded-xl border shrink-0 ${
              isDefault
                ? "bg-amber-50 text-amber-600 border-amber-200"
                : "bg-red-50 text-red-600 border-red-200"
            }`}
          >
            {isDefault ? (
              <AlertTriangle className="w-5 h-5" />
            ) : (
              <Trash2 className="w-5 h-5" />
            )}
          </div>
          <div className="min-w-0">
            <h4 className="text-sm font-bold text-gray-900 m-0 truncate">
              {isDefault
                ? t("setup.deleteDefaultApTitle", "Delete Default Access Point")
                : t("setup.deleteAccessPointTitle", "Delete Access Point")}
            </h4>
            <p className="text-xs text-gray-500 mt-0.5 truncate font-medium">
              {ap.name}
            </p>
          </div>
        </div>

        {isDefault ? (
          <>
            <p className="text-xs sm:text-sm text-gray-600 mb-3 leading-relaxed m-0">
              {t("setup.deleteDefaultApDesc", {
                name: ap.name,
                defaultValue: `Access Point "${ap.name}" is currently set as default. Please select a replacement default Access Point before deleting:`,
              })}
            </p>
            <div className="my-3">
              <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                {t("setup.selectReplacementAp", "Select replacement default access point:")}
              </label>
              <select
                value={selectedReplacementId}
                onChange={(e) => setSelectedReplacementId(e.target.value)}
                disabled={loading}
                className="w-full px-3 py-2 text-sm bg-white border border-[#d0d7de] rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-[#0969da] transition-all font-medium cursor-pointer"
              >
                {otherAps.map((other) => (
                  <option key={other.id} value={other.id}>
                    {other.name}
                  </option>
                ))}
              </select>
            </div>
          </>
        ) : (
          <p className="text-xs sm:text-sm text-gray-600 mb-4 leading-relaxed m-0">
            {t("setup.confirmDeleteApDesc", {
              name: ap.name,
              defaultValue: `Are you sure you want to delete access point "${ap.name}"? Devices connecting through this access point will no longer be able to resolve DNS.`,
            })}
          </p>
        )}
      </div>

      <div className={Classes.DIALOG_FOOTER}>
        <div className={Classes.DIALOG_FOOTER_ACTIONS}>
          <Button onClick={onClose} disabled={loading}>
            {t("common.cancel", "Cancel")}
          </Button>
          <Button
            intent={Intent.DANGER}
            loading={loading}
            onClick={handleConfirm}
            disabled={isDefault && otherAps.length === 0}
            icon={<Trash2 size={14} />}
          >
            {t("common.delete", "Delete")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};
