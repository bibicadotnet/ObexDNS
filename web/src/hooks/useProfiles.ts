import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useLocation } from "react-router-dom";
import {
  getProfiles,
  createProfile,
  deleteProfile
} from "../services";
import { formatApiErrorMessage } from "../utils/auth";
import type { Profile } from "../services";

interface PrefilledRule {
  domain: string;
  type: "ALLOW" | "BLOCK" | "REDIRECT";
  recordType?: string;
}

const ACTIVE_PROFILE_KEY = "obex_active_profile_id";

/**
 * Custom hook managing profiles list, selected profile,
 * dialog states, prefilled rules, and profile CRUD operations.
 *
 * @param isLoggedIn - Auth status from useAuth hook.
 */
export function useProfiles(isLoggedIn: boolean | null) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<Profile | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Profile creation states
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileIsDefault, setNewProfileIsDefault] = useState(false);
  const [newProfileApplyDefaultFilters, setNewProfileApplyDefaultFilters] = useState(true);
  const [createError, setCreateError] = useState("");

  // Profile deletion state (when deleting default profile)
  const [deletingProfile, setDeletingProfile] = useState<Profile | null>(null);

  // Quick Action / Prefilled Rule states
  const [prefilledRule, setPrefilledRule] = useState<PrefilledRule | null>(null);

  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();

  const fetchProfiles = async () => {
    try {
      const profilesData = await getProfiles();
      setProfiles(profilesData);
      const defaultP = profilesData.find(p => p.is_default) || [...profilesData].sort((a, b) => (a.created_at || 0) - (b.created_at || 0))[0];
      setSelectedProfile(prev => {
        const storedId = localStorage.getItem(ACTIVE_PROFILE_KEY);
        const targetId = prev?.id || storedId;
        const exists = targetId ? profilesData.find(p => p.id === targetId) : null;
        const chosen = exists || defaultP || null;
        if (chosen) {
          localStorage.setItem(ACTIVE_PROFILE_KEY, chosen.id);
        }
        return chosen;
      });
    } catch (err) {
      console.error("Failed to fetch profiles", err);
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    if (isLoggedIn === true) {
      fetchProfiles();
    } else {
      setProfiles([]);
      setSelectedProfile(null);
      setLoaded(false);
    }
  }, [isLoggedIn]);

  // 每次导航回 /dash（包括从 Account 页面返回）时重新拉取列表
  useEffect(() => {
    if (isLoggedIn === true && location.pathname === "/dash") {
      fetchProfiles();
    }
  }, [location.pathname]);

  const handleCreateProfile = async () => {
    const trimmedName = newProfileName.trim().replace(/\s+/g, ' ');
    if (!trimmedName) return;
    try {
      const shouldBeDefault = profiles.length === 0 ? true : newProfileIsDefault;
      await createProfile(trimmedName, shouldBeDefault, newProfileApplyDefaultFilters);
      setNewProfileName("");
      setNewProfileIsDefault(false);
      setNewProfileApplyDefaultFilters(true);
      setShowCreateDialog(false);
      await fetchProfiles();
    } catch (err: any) {
      setCreateError(formatApiErrorMessage(err, t));
    }
  };

  const handleDeleteProfile = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const target = profiles.find(p => p.id === id);
    if (!target) return;
    setDeletingProfile(target);
  };

  const confirmDeleteDefaultProfile = async (newDefaultId?: string) => {
    if (!deletingProfile) return;
    try {
      const deletedId = deletingProfile.id;
      if (deletingProfile.is_default && newDefaultId) {
        await deleteProfile(deletedId, newDefaultId);
      } else {
        await deleteProfile(deletedId);
      }
      setDeletingProfile(null);
      await fetchProfiles();
      if (selectedProfile?.id === deletedId) {
        localStorage.removeItem(ACTIVE_PROFILE_KEY);
        setSelectedProfile(null);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const cancelDeleteProfile = () => {
    setDeletingProfile(null);
  };

  const handleQuickAction = (
    domain: string,
    type: "ALLOW" | "BLOCK" | "REDIRECT",
    recordType?: string
  ) => {
    setPrefilledRule({ domain, type, recordType });
    const profileId = selectedProfile?.id || location.pathname.split("/")[2];
    if (profileId) {
      navigate(`/dash/${profileId}/rules`);
    }
  };

  return {
    profiles,
    selectedProfile,
    setSelectedProfile,
    showCreateDialog,
    setShowCreateDialog,
    newProfileName,
    setNewProfileName,
    newProfileIsDefault,
    setNewProfileIsDefault,
    newProfileApplyDefaultFilters,
    setNewProfileApplyDefaultFilters,
    createError,
    setCreateError,
    deletingProfile,
    confirmDeleteDefaultProfile,
    cancelDeleteProfile,
    prefilledRule,
    setPrefilledRule,
    fetchProfiles,
    handleCreateProfile,
    handleDeleteProfile,
    handleQuickAction,
    loaded,
  };
}
