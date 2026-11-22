import React from "react";
import { Button, Intent, Menu, MenuItem, PopoverNext } from "@blueprintjs/core";
import { ChevronRight, MoreHorizontal, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Profile } from "../../../types/auth";
import { ProfileAvatar } from "../../../layouts/ProfileSwitcher";

interface ProfileListProps {
  profiles: Profile[];
  onSelect: (p: Profile) => void;
  onDelete: (e: React.MouseEvent, id: string) => void;
  onCreate: () => void;
}

/**
 * Profile cards. Opening a profile is the one big target on each card;
 * delete is tucked into a "..." menu so it can never be tapped by accident.
 */
export const ProfileList: React.FC<ProfileListProps> = ({ profiles, onSelect, onDelete, onCreate }) => {
  const { t } = useTranslation();

  if (profiles.length === 0) {
    return (
      <div className="surface flex flex-col items-center gap-3 px-6 py-14 text-center">
        <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
          <ShieldCheck size={28} />
        </span>
        <h2 className="section-title">{t("common.welcome")}</h2>
        <p className="page-subtitle m-0">{t("common.createProfileToStart")}</p>
        <Button large intent={Intent.PRIMARY} icon={<Plus size={18} />} text={t("common.newProfile", "New profile")} onClick={onCreate} />
      </div>
    );
  }

  return (
    <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2">
      {profiles.map((p) => (
        <li key={p.id} className="surface relative flex items-stretch transition-shadow hover:shadow-md">
          <button
            type="button"
            onClick={() => onSelect(p)}
            className="flex min-h-20 min-w-0 flex-1 items-center gap-3 rounded-l-2xl p-4 text-left"
          >
            <ProfileAvatar name={p.name} size={44} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base font-bold text-gray-900">{p.name}</span>
              <code className="block truncate text-xs text-gray-500">{p.id}</code>
            </span>
            <ChevronRight size={18} className="shrink-0 text-gray-300" />
          </button>
          <div className="flex items-center pr-2">
            <PopoverNext
              placement="bottom-end"
              content={
                <Menu>
                  <MenuItem
                    icon={<Trash2 size={16} />}
                    intent={Intent.DANGER}
                    text={t("common.delete")}
                    onClick={(e) => onDelete(e as unknown as React.MouseEvent, p.id)}
                  />
                </Menu>
              }
            >
              <Button
                variant="minimal"
                icon={<MoreHorizontal size={18} />}
                aria-label={t("common.moreActions", "More actions")}
                title={t("common.moreActions", "More actions")}
              />
            </PopoverNext>
          </div>
        </li>
      ))}
    </ul>
  );
};
