import React from "react";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Profile, UserInfo } from "../types/auth";
import { SessionLockButton } from "../components/SessionLockButton";
import { SavingPill } from "../components/SavingPill";
import { ProfileSwitcher } from "./ProfileSwitcher";

interface MobileTopBarProps {
  profiles: Profile[];
  selectedProfile: Profile | null;
  onSwitchProfile: (profile: Profile) => void;
  onShowAllProfiles: () => void;
  /** Set on the account and system pages: the bar shows this title and a back button instead of the profile. */
  pageTitle?: string;
  onBack: () => void;
  isSaving?: boolean;
  currentUser: UserInfo | null;
}

/**
 * Phone top bar: "where am I" on the left, quick status on the right.
 * Language, account and log out live in the More sheet (bottom right, within thumb reach),
 * so this bar stays clean.
 */
export const MobileTopBar: React.FC<MobileTopBarProps> = ({
  profiles,
  selectedProfile,
  onSwitchProfile,
  onShowAllProfiles,
  pageTitle,
  onBack,
  isSaving,
  currentUser,
}) => {
  const { t } = useTranslation();

  return (
    <header className="pt-safe z-20 shrink-0 border-b border-gray-200 bg-white">
      <div className="flex h-14 items-center gap-2 px-3">
        {pageTitle ? (
          <>
            <button
              type="button"
              onClick={onBack}
              aria-label={t("common.back")}
              className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-gray-700 hover:bg-gray-100"
            >
              <ArrowLeft size={20} />
            </button>
            <h1 className="m-0 min-w-0 flex-1 truncate text-lg font-bold text-gray-900">{pageTitle}</h1>
          </>
        ) : (
          <div className="min-w-0 flex-1">
            <ProfileSwitcher
              profiles={profiles}
              selectedProfile={selectedProfile}
              onSelect={onSwitchProfile}
              onShowAll={onShowAllProfiles}
              className="border-transparent bg-transparent px-1.5"
            />
          </div>
        )}
        <div className="flex shrink-0 items-center gap-1">
          {isSaving && <SavingPill />}
          <SessionLockButton currentUser={currentUser} size="medium" />
        </div>
      </div>
    </header>
  );
};
