import React from "react";
import { Button, Intent, Spinner, InputGroup } from "@blueprintjs/core";
import { Plus, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AccessPoint } from "../../../types/auth";
import { SwipeableDrawer } from "../../../components/SwipeableDrawer";
import { useAccessPoints } from "../hooks/useAccessPoints";
import { AddAccessPointDialog } from "./AddAccessPointDialog";
import { RenameAccessPointDialog } from "./RenameAccessPointDialog";
import { AccessPointSection } from "./AccessPointSection";

export interface AccessPointDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  profileId: string;
  isMobile: boolean;
  accessPoints: AccessPoint[];
  loading: boolean;
  onRefresh: () => void;
  toasterRef: React.MutableRefObject<any>;
}

export const AccessPointDrawer: React.FC<AccessPointDrawerProps> = ({
  isOpen,
  onClose,
  profileId,
  isMobile,
  accessPoints,
  loading,
  onRefresh,
  toasterRef,
}) => {
  const { t } = useTranslation();

  const {
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
  } = useAccessPoints({
    profileId,
    accessPoints,
    onRefresh,
    toasterRef
  });

  return (
    <>
      <SwipeableDrawer
        isOpen={isOpen}
        onClose={onClose}
        title={
          isSearchOpen ? (
            <InputGroup
              leftIcon="search"
              placeholder={t("setup.searchAccessPoints", "Search...")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              rightElement={<Button icon="cross" minimal onClick={() => { setIsSearchOpen(false); setSearchQuery(""); }} />}
              autoFocus
            />
          ) : (
            <div className="flex items-center gap-2">
              <span>{t("setup.manageAccessPoints")}</span>
              <Button icon={<Search size={14} />} minimal onClick={() => setIsSearchOpen(true)} className="opacity-50 hover:opacity-100" />
            </div>
          )
        }
        icon="diagram-tree"
        size={isMobile ? "100%" : "450px"}
      >
        <Button 
          fill 
          intent={Intent.PRIMARY} 
          icon={<Plus size={16} />} 
          text={t("setup.addAccessPoint")} 
          onClick={() => setIsAddDialogOpen(true)}
          large
        />

        {loading ? (
          <div className="flex justify-center p-8"><Spinner /></div>
        ) : (
          <div className="space-y-4 mt-4">
            {filteredAccessPoints.map(ap => (
              <AccessPointSection
                key={ap.id}
                ap={ap}
                totalApCount={accessPoints.length}
                toasterRef={toasterRef}
                onRenameTrigger={(id, name) => {
                  setRenameApId(id);
                  setRenameApName(name);
                }}
                rotateConfirmApId={rotateConfirmApId}
                setRotateConfirmApId={setRotateConfirmApId}
                rotatingApId={rotatingApId}
                handleRotate={handleRotate}
                deletingApId={deletingApId}
                handleDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </SwipeableDrawer>

      <AddAccessPointDialog
        isOpen={isAddDialogOpen}
        onClose={() => { setIsAddDialogOpen(false); setNewApName(""); }}
        newApName={newApName}
        setNewApName={setNewApName}
        newApNameFocused={newApNameFocused}
        setNewApNameFocused={setNewApNameFocused}
        handleAdd={handleAdd}
        isAdding={isAdding}
        isValidApName={isValidApName}
      />

      <RenameAccessPointDialog
        isOpen={!!renameApId}
        onClose={() => setRenameApId(null)}
        renameApName={renameApName}
        setRenameApName={setRenameApName}
        renameApNameFocused={renameApNameFocused}
        setRenameApNameFocused={setRenameApNameFocused}
        handleRename={handleRename}
        isRenaming={isRenaming}
        isValidApName={isValidApName}
      />
    </>
  );
};
