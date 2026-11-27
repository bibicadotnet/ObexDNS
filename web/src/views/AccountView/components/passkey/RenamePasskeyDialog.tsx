import React from "react";
import {
  Dialog,
  Classes,
  Callout,
  Intent,
  FormGroup,
  Tooltip,
  Position,
  InputGroup,
  Button
} from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import { validatePasskeyName } from "../../../../utils/auth";

/**
 * Props for the RenamePasskeyDialog component.
 */
export interface RenamePasskeyDialogProps {
  /** Whether the modal dialog is open. */
  isOpen: boolean;
  /** Callback to close the dialog. */
  onClose: () => void;
  /** Current edit name input value. */
  editName: string;
  /** Callback to update edit name. */
  setEditName: (name: string) => void;
  /** Whether the input is currently focused. */
  renameFocused: boolean;
  /** Callback to update focus state. */
  setRenameFocused: (focused: boolean) => void;
  /** Whether renaming submission is in progress. */
  renaming: boolean;
  /** Error message string if rename failed. */
  renameError: string;
  /** Callback to clear or update error message. */
  setRenameError: (err: string) => void;
  /** Form submission handler. */
  onSubmit: (e: React.FormEvent) => void;
}

/**
 * RenamePasskeyDialog renders the modal dialog form for renaming a registered passkey.
 *
 * @param props - Component props.
 * @returns React modal dialog element.
 */
export const RenamePasskeyDialog: React.FC<RenamePasskeyDialogProps> = ({
  isOpen,
  onClose,
  editName,
  setEditName,
  renameFocused,
  setRenameFocused,
  renaming,
  renameError,
  setRenameError,
  onSubmit
}) => {
  const { t } = useTranslation();

  return (
    <Dialog
      isOpen={isOpen}
      onClose={() => !renaming && onClose()}
      title={t("account.passkey.renameTitle", "Rename Passkey")}
      className="max-w-md"
    >
      <form onSubmit={onSubmit}>
        <div className={Classes.DIALOG_BODY}>
          {renameError && (
            <Callout intent={Intent.DANGER} className="mb-4">
              {renameError}
            </Callout>
          )}
          <FormGroup
            label={t("account.passkey.appNameLabel", "Application (Domain)")}
          >
            <InputGroup
              readOnly
              disabled
              leftIcon="globe"
              value={window.location.hostname}
            />
          </FormGroup>
          <FormGroup
            label={t("account.passkey.nameLabel", "Passkey Name")}
            helperText={t(
              "account.passkey.formatTip",
              "1-30 characters, letters, numbers, hyphens and underscores allowed"
            )}
          >
            <Tooltip
              content={t(
                "account.passkey.formatTip",
                "1-30 characters, letters, numbers, hyphens and underscores allowed"
              )}
              isOpen={renameFocused}
              position={Position.TOP}
              intent={Intent.PRIMARY}
              className="w-full"
            >
              <div className="w-full block">
                <InputGroup
                  autoFocus
                  placeholder={t(
                    "account.passkey.namePlaceholder",
                    "e.g. my_passkey"
                  )}
                  value={editName}
                  onChange={(e) => {
                    setEditName(e.target.value);
                    if (renameError) setRenameError("");
                  }}
                  onFocus={() => setRenameFocused(true)}
                  onBlur={() => setRenameFocused(false)}
                  disabled={renaming}
                />
              </div>
            </Tooltip>
          </FormGroup>
        </div>
        <div className={Classes.DIALOG_FOOTER}>
          <div className={Classes.DIALOG_FOOTER_ACTIONS}>
            <Button
              text={t("common.cancel", "Cancel")}
              onClick={onClose}
              disabled={renaming}
            />
            <Button
              intent={Intent.PRIMARY}
              type="submit"
              text={t("common.save", "Save")}
              loading={renaming}
              disabled={!validatePasskeyName(editName.trim()) || renaming}
            />
          </div>
        </div>
      </form>
    </Dialog>
  );
};
