import { useState } from "react";
import { Intent } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import type { AccessPoint } from "../../../types/auth";
import { AP_NAME_REGEX } from "../../../utils/auth";
import {
  addProfileAccessPoint,
  renameProfileAccessPoint,
  rotateProfileAccessPointToken,
  deleteProfileAccessPoint
} from "../../../services";

export interface UseAccessPointsProps {
  profileId: string;
  accessPoints: AccessPoint[];
  onRefresh: () => void;
  toasterRef: React.MutableRefObject<any>;
}

export function useAccessPoints({
  profileId,
  accessPoints,
  onRefresh,
  toasterRef
}: UseAccessPointsProps) {
  const { t } = useTranslation();

  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [newApName, setNewApName] = useState("");
  const [isAdding, setIsAdding] = useState(false);

  const [renameApId, setRenameApId] = useState<string | null>(null);
  const [renameApName, setRenameApName] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);

  const [rotatingApId, setRotatingApId] = useState<string | null>(null);
  const [deletingApId, setDeletingApId] = useState<string | null>(null);

  const [newApNameFocused, setNewApNameFocused] = useState(false);
  const [renameApNameFocused, setRenameApNameFocused] = useState(false);
  const [rotateConfirmApId, setRotateConfirmApId] = useState<string | null>(null);

  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const filteredAccessPoints = accessPoints.filter(ap => 
    ap.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    ap.token.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const isValidApName = (name: string) => AP_NAME_REGEX.test(name);

  const handleAdd = async () => {
    const trimmedName = newApName.trim();
    if (!trimmedName) return;

    if (accessPoints.some(ap => ap.name.toLowerCase() === trimmedName.toLowerCase())) {
      toasterRef.current?.show({ message: t("setup.accessPointNameExists", "Access Point name already exists"), intent: Intent.DANGER });
      return;
    }

    setIsAdding(true);
    try {
      await addProfileAccessPoint(profileId, trimmedName);
      toasterRef.current?.show({ message: t("setup.accessPointCreated"), intent: Intent.SUCCESS });
      setIsAddDialogOpen(false);
      setNewApName("");
      onRefresh();
    } catch (e: any) {
      const errMsg = e.message || "Failed to create access point";
      let displayMsg = errMsg;
      if (errMsg.startsWith("Access point limit exceeded")) {
        const match = errMsg.match(/\(max (\d+)\)/);
        const maxVal = match ? match[1] : "100";
        displayMsg = t("setup.accessPointLimitExceeded", { max: maxVal, defaultValue: `Access Point limit exceeded (max ${maxVal})` });
      }
      toasterRef.current?.show({ message: displayMsg, intent: Intent.DANGER });
    } finally {
      setIsAdding(false);
    }
  };

  const handleRename = async () => {
    const trimmedName = renameApName.trim();
    if (!trimmedName || !renameApId) return;

    if (accessPoints.some(ap => ap.id !== renameApId && ap.name.toLowerCase() === trimmedName.toLowerCase())) {
      toasterRef.current?.show({ message: t("setup.accessPointNameExists", "Access Point name already exists"), intent: Intent.DANGER });
      return;
    }

    setIsRenaming(true);
    try {
      await renameProfileAccessPoint(profileId, renameApId, trimmedName);
      toasterRef.current?.show({ message: t("setup.accessPointRenamed"), intent: Intent.SUCCESS });
      setRenameApId(null);
      onRefresh();
    } catch (e: any) {
      toasterRef.current?.show({ message: e.message || "Failed to rename access point", intent: Intent.DANGER });
    } finally {
      setIsRenaming(false);
    }
  };

  const handleRotate = async (apId: string) => {
    setRotatingApId(apId);
    try {
      await rotateProfileAccessPointToken(profileId, apId);
      toasterRef.current?.show({ message: t("setup.tokenRotated"), intent: Intent.SUCCESS });
      onRefresh();
    } catch (e) {
      console.error(e);
    } finally {
      setRotatingApId(null);
    }
  };

  const handleDelete = async (apId: string) => {
    if (!confirm(t("setup.deleteAccessPointConfirm"))) return;
    setDeletingApId(apId);
    try {
      await deleteProfileAccessPoint(profileId, apId);
      toasterRef.current?.show({ message: t("setup.accessPointDeleted"), intent: Intent.SUCCESS });
      onRefresh();
    } catch (e) {
      console.error(e);
    } finally {
      setDeletingApId(null);
    }
  };

  return {
    isAddDialogOpen,
    setIsAddDialogOpen,
    newApName,
    setNewApName,
    isAdding,
    renameApId,
    setRenameApId,
    renameApName,
    setRenameApName,
    isRenaming,
    rotatingApId,
    deletingApId,
    newApNameFocused,
    setNewApNameFocused,
    renameApNameFocused,
    setRenameApNameFocused,
    rotateConfirmApId,
    setRotateConfirmApId,
    isSearchOpen,
    setIsSearchOpen,
    searchQuery,
    setSearchQuery,
    filteredAccessPoints,
    isValidApName,
    handleAdd,
    handleRename,
    handleRotate,
    handleDelete
  };
}
