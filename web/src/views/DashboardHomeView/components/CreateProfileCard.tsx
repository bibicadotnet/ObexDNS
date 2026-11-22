import React, { useState } from "react";
import { Button, FormGroup, InputGroup, Intent } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import { PROFILE_NAME_REGEX } from "../../../utils/auth";

interface CreateProfileCardProps {
  newName: string;
  setNewName: (name: string) => void;
  onCreate: () => void;
  setShowCreate: (show: boolean) => void;
  error: string;
}

/** Inline "new profile" form. Enter creates, Escape cancels, and the rule is explained before you type. */
export const CreateProfileCard: React.FC<CreateProfileCardProps> = ({
  newName,
  setNewName,
  onCreate,
  setShowCreate,
  error,
}) => {
  const { t } = useTranslation();
  const [touched, setTouched] = useState(false);
  const valid = PROFILE_NAME_REGEX.test(newName);

  const getErrorMessage = (err: string) => {
    if (!err) return "";
    if (err.startsWith("Profile limit exceeded")) {
      const match = err.match(/\(max (\d+)\)/);
      const maxVal = match ? match[1] : "10";
      return t("common.profileLimitExceeded", { max: maxVal, defaultValue: `Profile limit exceeded (max ${maxVal})` });
    }
    if (err === "The profile name already exists") return t("common.profileNameExists", "The profile name already exists");
    if (err === "Invalid Profile Name format") return t("common.profileNameFormatError", "Invalid Profile Name format");
    return err;
  };

  const message = error
    ? getErrorMessage(error)
    : touched && !valid
      ? t("common.profileNameFormatError", "Invalid Profile Name format")
      : "";

  return (
    <form
      className="surface mb-4 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onCreate();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") setShowCreate(false);
      }}
    >
      <FormGroup
        className="mb-3!"
        label={t("common.newProfileName")}
        labelFor="new-profile-name"
        helperText={message ? undefined : t("common.profileNameFormatTip", "Profile Name tip: 1-30 characters, duplicates not allowed")}
        intent={message ? Intent.DANGER : Intent.NONE}
        subLabel={message ? <span className="text-red-700">{message}</span> : undefined}
      >
        <InputGroup
          id="new-profile-name"
          large
          fill
          autoFocus
          value={newName}
          intent={message ? Intent.DANGER : Intent.NONE}
          onChange={(e) => setNewName(e.target.value)}
          onBlur={() => setTouched(true)}
        />
      </FormGroup>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button text={t("common.cancel")} onClick={() => setShowCreate(false)} />
        <Button type="submit" intent={Intent.PRIMARY} text={t("common.create")} disabled={!valid} />
      </div>
    </form>
  );
};
