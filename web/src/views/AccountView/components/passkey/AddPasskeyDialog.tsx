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
 * Props for the AddPasskeyDialog component.
 */
export interface AddPasskeyDialogProps {
  /** Whether the modal dialog is open. */
  isOpen: boolean;
  /** Callback to close the dialog. */
  onClose: () => void;
  /** Current passkey name input value. */
  passkeyName: string;
  /** Callback to update passkey name. */
  setPasskeyName: (name: string) => void;
  /** Whether the input is currently focused. */
  nameFocused: boolean;
  /** Callback to update focus state. */
  setNameFocused: (focused: boolean) => void;
  /** Whether registration is actively running. */
  registering: boolean;
  /** Error message string if registration failed. */
  addError: string;
  /** Callback to clear or update error message. */
  setAddError: (err: string) => void;
  /** Form submission handler. */
  onSubmit: (e: React.FormEvent) => void;
}

/**
 * AddPasskeyDialog renders the dialog form to register a new WebAuthn passkey.
 *
 * @param props - Component props.
 * @returns React modal dialog element.
 */
export const AddPasskeyDialog: React.FC<AddPasskeyDialogProps> = ({
  isOpen,
  onClose,
  passkeyName,
  setPasskeyName,
  nameFocused,
  setNameFocused,
  registering,
  addError,
  setAddError,
  onSubmit
}) => {
  const { t } = useTranslation();

  return (
    <Dialog
      isOpen={isOpen}
      onClose={() => !registering && onClose()}
      title={t("account.passkey.addTitle", "Add New Passkey")}
      className="max-w-md"
    >
      <form onSubmit={onSubmit}>
        <div className={Classes.DIALOG_BODY}>
          {addError && (
            <Callout intent={Intent.DANGER} className="mb-4">
              {addError}
            </Callout>
          )}
          <FormGroup
            label={t("account.passkey.nameLabel", "Passkey Name")}
            labelFor="passkey-name-input"
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
              isOpen={nameFocused}
              position={Position.TOP}
              intent={Intent.PRIMARY}
              className="w-full"
            >
              <div className="w-full block">
                <InputGroup
                  id="passkey-name-input"
                  autoFocus
                  placeholder={t(
                    "account.passkey.namePlaceholder",
                    "e.g. my_passkey"
                  )}
                  value={passkeyName}
                  onChange={(e) => {
                    setPasskeyName(e.target.value);
                    if (addError) setAddError("");
                  }}
                  onFocus={() => setNameFocused(true)}
                  onBlur={() => setNameFocused(false)}
                  disabled={registering}
                />
              </div>
            </Tooltip>
          </FormGroup>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t(
              "account.passkey.promptNotice",
              "After clicking continue, your browser will prompt you to authenticate via Key, face scan, PIN, or hardware key."
            )}
          </p>
        </div>
        <div className={Classes.DIALOG_FOOTER}>
          <div className={Classes.DIALOG_FOOTER_ACTIONS}>
            <Button
              text={t("common.cancel", "Cancel")}
              onClick={onClose}
              disabled={registering}
            />
            <Button
              intent={Intent.PRIMARY}
              type="submit"
              text={t("account.passkey.continue", "Continue")}
              loading={registering}
              disabled={!validatePasskeyName(passkeyName.trim()) || registering}
            />
          </div>
        </div>
      </form>
    </Dialog>
  );
};
