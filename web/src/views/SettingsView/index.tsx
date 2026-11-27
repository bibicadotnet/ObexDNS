import React, { useState, useEffect, useRef, useCallback } from "react";
import { Spinner, Intent } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";

import type {  Profile, ProfileSettings, SettingsViewProps, TestResponse  } from "./types";
import { SettingsHeader } from "./components/SettingsHeader";
import { UpstreamCard } from "./components/UpstreamCard";
import { LogRetentionCard } from "./components/LogRetentionCard";
import { AdvancedEcsCard } from "./components/AdvancedEcsCard";
import { BestEffortEchCard } from "./components/BestEffortEchCard";
import { DnsTestCard } from "./components/DnsTestCard";
import {
  getProfileDetails,
  renameProfile,
  updateProfileSettings,
  testResolution,
  getProfileRules,
  getProfileLists,
  probeUpstream
} from "../../services";
import { executeWithTimeout } from "../../utils/async";
import { useBranding } from "../../hooks/useBranding";

export const SettingsView: React.FC<SettingsViewProps> = ({ profileId, toasterRef, currentUser, onSavingChange }) => {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [settings, setSettings] = useState<ProfileSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingStatus, setSavingStatus] = useState<"saving" | "verifying" | false>(false);
  const { t } = useTranslation();
  const { appName } = useBranding();

  useEffect(() => {
    onSavingChange?.(savingStatus);
    return () => {
      onSavingChange?.(false);
    };
  }, [savingStatus, onSavingChange]);

  const isInitialLoad = useRef(true);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastConfirmedSettingsRef = useRef<ProfileSettings | null>(null);
  const saveSeqRef = useRef(0);

  const cloneSettings = (s: ProfileSettings): ProfileSettings => {
    return typeof structuredClone === "function" ? structuredClone(s) : JSON.parse(JSON.stringify(s));
  };

  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState("");
  const [editIsDefault, setEditIsDefault] = useState(false);

  // DNS 测试相关状态
  const [testInput, setTestInput] = useState({
    domain: "o-o.myaddr.l.google.com",
    type: "TXT",
  });
  const [testResult, setTestResult] = useState<TestResponse | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    isInitialLoad.current = true;
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    const fetchProfile = async () => {
      setLoading(true);
      try {
        const data = await getProfileDetails(profileId) as any;
        setProfile(data);
        setEditName(data.name);
        setEditIsDefault(Boolean(data.is_default));
        const parsed = JSON.parse(data.settings);
        lastConfirmedSettingsRef.current = cloneSettings(parsed);
        setSettings(parsed);
        return profile;
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    fetchProfile();
  }, [profileId]);

  useEffect(() => {
    if (!loading && settings && isInitialLoad.current) {
      const timer = setTimeout(() => {
        isInitialLoad.current = false;
        if (settings) {
          lastConfirmedSettingsRef.current = cloneSettings(settings);
        }
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [loading, settings]);

  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  const updateProfileName = async () => {
    const trimmedName = editName.trim().replace(/\s+/g, ' ');
    const isDefaultChanged = Boolean(profile?.is_default) !== editIsDefault;
    if (!trimmedName || (trimmedName === profile?.name && !isDefaultChanged)) {
      setIsEditingName(false);
      return;
    }
    const previousName = profile?.name || "";
    setSavingStatus("saving");
    try {
      await executeWithTimeout(renameProfile(profileId, trimmedName, editIsDefault), 10000);
      setProfile((prev) => (prev ? { ...prev, name: trimmedName, is_default: editIsDefault } : null));
      setEditName(trimmedName);
      setIsEditingName(false);
      toasterRef?.current?.show({
        message: t("common.saveSuccess", "Saved successfully"),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
    } catch (e: any) {
      console.error(e);
      // Revert to original profile name
      setEditName(previousName);
      setIsEditingName(false);
      const rawErr = e.message;
      let errMsg = rawErr;
      if (rawErr === "The profile name already exists") {
        errMsg = t("common.profileNameExists", "The profile name already exists");
      } else if (rawErr === "Invalid Profile Name format") {
        errMsg = t("common.profileNameFormatError", "Invalid Profile Name format");
      }
      toasterRef?.current?.show({
        message: errMsg || t("common.saveFailed", "Save failed"),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setSavingStatus(false);
    }
  };

  const saveSettings = useCallback(async (settingsToSave: ProfileSettings) => {
    if (!settingsToSave) return;
    const currentSeq = ++saveSeqRef.current;
    setSavingStatus("saving");
    try {
      // Upstream changes are verified with a real DNS query on the server, which can take several seconds.
      await executeWithTimeout(updateProfileSettings(profileId, settingsToSave as any), 20000);
      if (currentSeq === saveSeqRef.current) {
        lastConfirmedSettingsRef.current = cloneSettings(settingsToSave);
        toasterRef?.current?.show({
          message: t("common.saveSuccess", "Saved successfully"),
          intent: Intent.SUCCESS,
          icon: "tick",
        });
      }
    } catch (e) {
      console.error(e);
      if (currentSeq === saveSeqRef.current) {
        // 1. 取消正在等待的防抖定时器，防止覆盖回滚
        if (debounceTimer.current) {
          clearTimeout(debounceTimer.current);
          debounceTimer.current = null;
        }
        // 2. 将视图显示的值恢复为上一次保存成功的原值
        if (lastConfirmedSettingsRef.current) {
          setSettings(cloneSettings(lastConfirmedSettingsRef.current));
        }
        // 3. Toast: show the server's validation message (e.g. "Upstream verification failed: ...")
        //    when there is one, otherwise the generic failure text.
        const serverMsg = e instanceof Error ? e.message.trim() : "";
        const detail = serverMsg && serverMsg.length <= 400 && !serverMsg.startsWith("<") ? serverMsg : "";
        toasterRef?.current?.show({
          message: detail
            ? `${t("common.saveFailed", "Save failed")}: ${detail}`
            : t("common.saveFailed", "Save failed"),
          intent: Intent.DANGER,
          icon: "error",
          timeout: detail ? 8000 : undefined,
        });
      }
    } finally {
      if (currentSeq === saveSeqRef.current) {
        setSavingStatus(false);
      }
    }
  }, [profileId, toasterRef, t]);

  const debouncedSave = useCallback(
    (newSettings: ProfileSettings) => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        saveSettings(newSettings);
      }, 600);
    },
    [saveSettings],
  );

  const handleSettingsChange = useCallback(
    async (newSettings: ProfileSettings) => {
      setSettings(newSettings);
      if (isInitialLoad.current) return;

      const lastUpstream = lastConfirmedSettingsRef.current?.upstream || [];
      const isUpstreamChanged = JSON.stringify(newSettings.upstream) !== JSON.stringify(lastUpstream);

      if (isUpstreamChanged) {
        if (debounceTimer.current) {
          clearTimeout(debounceTimer.current);
          debounceTimer.current = null;
        }
        const currentSeq = ++saveSeqRef.current;
        setSavingStatus("verifying");
        try {
          const probeRes = await executeWithTimeout(probeUpstream(profileId, newSettings.upstream), 5000);
          if (!probeRes?.ok) {
            throw new Error(probeRes?.error || "Upstream verification failed");
          }
          if (currentSeq === saveSeqRef.current) {
            setSavingStatus("saving");
            saveSettings(newSettings);
          }
        } catch (e: any) {
          console.error(e);
          if (currentSeq === saveSeqRef.current) {
            if (lastConfirmedSettingsRef.current) {
              setSettings(cloneSettings(lastConfirmedSettingsRef.current));
            }
            const serverMsg = e instanceof Error ? e.message.trim() : "";
            const detail = serverMsg && serverMsg.length <= 400 && !serverMsg.startsWith("<") ? serverMsg : "";
            toasterRef?.current?.show({
              message: detail
                ? `${t("common.saveFailed", "Save failed")}: ${detail}`
                : t("common.saveFailed", "Save failed"),
              intent: Intent.DANGER,
              icon: "error",
              timeout: detail ? 8000 : undefined,
            });
            setSavingStatus(false);
          }
        }
        return;
      }

      debouncedSave(newSettings);
    },
    [profileId, debouncedSave, saveSettings, toasterRef, t],
  );

  const handleDnsTest = async () => {
    if (!testInput.domain) return;
    setTesting(true);
    setTestResult(null);
    try {
      const data = await testResolution(profileId, testInput);
      setTestResult(data);
    } catch (e) {
      console.error(e);
    } finally {
      setTesting(false);
    }
  };

  const exportProfile = async () => {
    if (!profile || !settings) return;
    try {
      const [rawRules, rawLists] = await Promise.all([
        getProfileRules(profileId).catch(() => []),
        getProfileLists(profileId).catch(() => [])
      ]);

      const seenPatterns = new Set<string>();
      const rules = (rawRules || []).filter((r) => {
        const norm = (r.pattern || "").trim().toLowerCase();
        if (!norm || seenPatterns.has(norm)) return false;
        seenPatterns.add(norm);
        return true;
      });

      const seenUrls = new Set<string>();
      const filters = (rawLists || [])
        .filter((l) => {
          const norm = (l.url || "").trim().toLowerCase();
          if (!norm || seenUrls.has(norm)) return false;
          seenUrls.add(norm);
          return true;
        })
        .map((l) => ({
          url: l.url,
          enabled: Boolean(l.enabled)
        }));

      // Profile export schema version: v1 = legacy (rules only), v2 = added external filter lists (filters)
      const exportData = {
        version: 2,
        name: profile.name,
        settings: settings,
        rules: rules,
        filters: filters,
        exported_at: Math.floor(Date.now() / 1000),
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const appPrefix = (appName || "dns-worker")
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      a.download = `${appPrefix || "dns-worker"}-${profile.name || profileId}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toasterRef?.current?.show({
        message: t("settings.exportSuccess", "Config exported successfully"),
        intent: Intent.SUCCESS,
        icon: "download",
      });
    } catch (e) {
      console.error(e);
      toasterRef?.current?.show({
        message: t("settings.exportError", "Export failed"),
        intent: Intent.DANGER,
        icon: "error",
      });
    }
  };

  if (loading || !settings)
    return (
      <div className="p-20 flex justify-center">
        <Spinner />
      </div>
    );

  return (
    <div className="w-full min-w-0 max-w-5xl mx-auto px-1 md:px-8 space-y-6 pb-24">
      <SettingsHeader
        profile={profile}
        isEditingName={isEditingName}
        setIsEditingName={setIsEditingName}
        editName={editName}
        setEditName={setEditName}
        editIsDefault={editIsDefault}
        setEditIsDefault={setEditIsDefault}
        updateProfileName={updateProfileName}
        exportProfile={exportProfile}
      />

      {/* Row 1: Upstream + ECH, row 2: ECS + LogRetention. Cards in a row are stretched to the same height. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-stretch">
        <UpstreamCard settings={settings} setSettings={handleSettingsChange} />
        <BestEffortEchCard settings={settings} setSettings={handleSettingsChange} />
        <AdvancedEcsCard settings={settings} setSettings={handleSettingsChange} />
        <LogRetentionCard
          settings={settings}
          setSettings={handleSettingsChange}
          isAdmin={currentUser?.role === "admin"}
          maxRetentionDays={currentUser?.max_log_retention_days ?? (currentUser?.role === "admin" ? 30 : 7)}
          profileId={profileId}
          toasterRef={toasterRef}
        />
      </div>

      <DnsTestCard
        testInput={testInput}
        setTestInput={setTestInput}
        handleDnsTest={handleDnsTest}
        testing={testing}
        testResult={testResult}
      />
    </div>
  );
};
