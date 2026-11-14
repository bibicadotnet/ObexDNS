import React, { useState, useEffect, useRef } from "react";
import { Button, Intent, Callout, ButtonGroup } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useIsMobile } from "../../hooks/useIsMobile";
import { clsx } from "clsx";

import type {  FilteringViewProps, FilterList  } from "./types";
import { AddListCard } from "./components/AddListCard";
import { ListsTable } from "./components/ListsTable";
import { ListDetailsDialog } from "./components/ListDetailsDialog";
import { getProfileLists, addCustomProfileList, deleteCustomProfileList, syncProfileLists, syncSingleProfileList, toggleProfileList, addProfileRule } from "../../services";

export const FilteringView: React.FC<FilteringViewProps> = ({ profileId, toasterRef }) => {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [lists, setLists] = useState<FilterList[]>([]);
  const [newUrl, setNewUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const { t } = useTranslation();

  const [selectedList, setSelectedList] = useState<FilterList | null>(null);

  /** List ids with a toggle request in flight; their switch is locked in the table. */
  const [pendingToggleIds, setPendingToggleIds] = useState<ReadonlySet<number>>(new Set());
  const pendingToggles = useRef(0);

  const fetchData = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await getProfileLists(profileId);
      setLists(data);
    } catch (e) {
      console.error("Failed to fetch filters", e);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toasterRef?.current?.show({
      message: t("setup.copied", "已复制到剪贴板"),
      intent: Intent.SUCCESS,
      icon: "duplicate",
    });
  };

  const waitForSyncCompletion = async (oldLists: FilterList[]) => {
    const oldSyncTimes = new Map(oldLists.map(l => [l.id, l.last_synced_at]));
    let attempts = 0;
    const maxAttempts = 15; // 30 seconds max
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      try {
        const data = await getProfileLists(profileId);
        const newLists = data as FilterList[];
        
        let allUpdated = true;
        for (const list of newLists) {
          if (oldSyncTimes.has(list.id) && list.last_synced_at === oldSyncTimes.get(list.id)) {
            allUpdated = false;
            break;
          }
          if (!oldSyncTimes.has(list.id) && !list.last_synced_at) {
            allUpdated = false;
            break;
          }
        }
        
        if (allUpdated && newLists.length > 0) {
          setLists(newLists);
          return true;
        }
      } catch (e) {
        // Ignore fetch errors during polling
      }
      attempts++;
    }
    
    await fetchData();
    return false;
  };

  const waitForSingleSyncCompletion = async (listId: number, oldSyncTime?: number | null) => {
    let attempts = 0;
    const maxAttempts = 15; // 30 seconds max
    while (attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        const data = await getProfileLists(profileId);
        const newLists = data as FilterList[];
        const current = newLists.find((l) => l.id === listId);
        if (current && (current.last_synced_at ?? 0) !== (oldSyncTime ?? 0)) {
          setLists(newLists);
          setSelectedList(current);
          return true;
        }
      } catch (e) {
        // Ignore fetch errors during polling
      }
      attempts++;
    }
    await fetchData();
    return false;
  };

  const handleSyncSingleList = async (listId: number) => {
    try {
      const oldList = lists.find((l) => l.id === listId);
      const oldSyncTime = oldList?.last_synced_at;
      await syncSingleProfileList(profileId, listId);
      toasterRef?.current?.show({
        message: t("filtering.singleSyncStarted", "列表同步任务已开始"),
        intent: Intent.PRIMARY,
        icon: "cloud-download",
      });
      const completed = await waitForSingleSyncCompletion(listId, oldSyncTime);
      if (completed) {
        toasterRef?.current?.show({
          message: t("filtering.syncCheckComplete"),
          intent: Intent.SUCCESS,
          icon: "tick",
        });
      }
    } catch (e) {
      console.error(e);
      toasterRef?.current?.show({
        message: e instanceof Error ? e.message : String(e),
        intent: Intent.DANGER,
        icon: "error",
      });
    }
  };

  const addList = async (urlToAdd?: string) => {
    const url = urlToAdd || newUrl;
    if (!url) return;
    setSyncing(true);
    try {
      const result = await addCustomProfileList(profileId, url);
      toasterRef?.current?.show({
        message: t("filtering.addSuccess"),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
      setNewUrl("");

      toasterRef?.current?.show({
        message: t("filtering.singleSyncStarted", "列表同步任务已开始"),
        intent: Intent.PRIMARY,
        icon: "cloud-download",
      });

      let targetId = result?.id;
      if (!targetId) {
        const fresh = await getProfileLists(profileId);
        const created = fresh.find((l) => l.url.trim().toLowerCase() === url.trim().toLowerCase());
        targetId = created?.id;
        setLists(fresh);
      }

      if (targetId) {
        const completed = await waitForSingleSyncCompletion(targetId, 0);
        if (completed) {
          toasterRef?.current?.show({
            message: t("filtering.syncCheckComplete"),
            intent: Intent.SUCCESS,
            icon: "tick",
          });
        }
      } else {
        await fetchData();
      }
    } catch (e) {
      console.error(e);
      toasterRef?.current?.show({
        message: e instanceof Error ? e.message : String(e),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setSyncing(false);
    }
  };

  /**
   * Enables or disables a list. The row flips immediately (optimistic) and is rolled
   * back if the request fails, so toggling from the table never blanks the whole view.
   * The worker rebuilds the filter from the lists still active, with no re-download.
   */
  const setListEnabled = async (id: number, enabled: boolean) => {
    setLists((prev) => prev.map((l) => (l.id === id ? { ...l, enabled } : l)));
    setSelectedList((prev) => (prev && prev.id === id ? { ...prev, enabled } : prev));
    setPendingToggleIds((prev) => new Set(prev).add(id));
    pendingToggles.current++;
    try {
      await toggleProfileList(profileId, id, enabled);
      toasterRef?.current?.show({
        message: enabled
          ? t("filtering.listEnabledToast", "List enabled - rebuilding filter")
          : t("filtering.listDisabledToast", "List disabled - rebuilding filter"),
        intent: Intent.PRIMARY,
        icon: enabled ? "tick" : "disable",
      });
    } catch (e) {
      console.error(e);
      setLists((prev) => prev.map((l) => (l.id === id ? { ...l, enabled: !enabled } : l)));
      setSelectedList((prev) => (prev && prev.id === id ? { ...prev, enabled: !enabled } : prev));
      toasterRef?.current?.show({
        message: e instanceof Error ? e.message : String(e),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setPendingToggleIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      pendingToggles.current--;
      // Resync with the server only once every toggle has settled; refetching mid-burst
      // would overwrite a later optimistic flip with stale server state.
      if (pendingToggles.current === 0) await fetchData(true);
    }
  };

  /**
   * Adds an ALLOW rule for a domain an external list blocks. The resolver
   * checks the allow list before consulting the bloom filter, so the exception
   * wins - and because rules live outside lists, it survives the next sync.
   */
  const allowDomain = async (domain: string) => {
    await addProfileRule(profileId, { type: "ALLOW", pattern: domain });
    toasterRef?.current?.show({
      message: t("filtering.allowRuleAdded", "Exception added for {{domain}}", { domain }),
      intent: Intent.SUCCESS,
      icon: "tick",
    });
  };

  const deleteList = async (id: number) => {
    try {
      await deleteCustomProfileList(profileId, id);
      toasterRef?.current?.show({
        message: t("filtering.deleteSuccess"),
        intent: Intent.PRIMARY,
        icon: "trash",
      });
      setSelectedList(null);
      await fetchData();
    } catch (e) {
      console.error(e);
    }
  };

  const syncLists = async () => {
    setSyncing(true);
    try {
      await syncProfileLists(profileId);
      toasterRef?.current?.show({
        message: t("filtering.syncTaskStarted"),
        intent: Intent.PRIMARY,
        icon: "cloud-download",
      });
      
      const completed = await waitForSyncCompletion(lists);
      if (completed) {
        toasterRef?.current?.show({
          message: t("filtering.syncCheckComplete"),
          intent: Intent.SUCCESS,
          icon: "tick",
        });
      }
    } catch (e) {
      console.error(e);
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [profileId]);

  return (
    <div className={clsx("md:px-8 w-full min-w-0 max-w-5xl mx-auto", isMobile ? "p-1" : "px-8")}>
      <div className="mb-8 flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div className="w-full md:w-auto flex-1">
          {isMobile ? (
            <ButtonGroup minimal fill={isMobile}>
              <Button
                active={false}
                onClick={() => navigate(`/dash/${profileId}/rules`)}
                text={t("rules.title")}
                large
              />
              <Button
                active={true}
                onClick={() => navigate(`/dash/${profileId}/filter`)}
                text={t("filtering.title")}
                large
              />
            </ButtonGroup>
          ) : (
            <h1 className="bp6-heading">{t("filtering.title")}</h1>
          )}
          <p className="bp6-text-muted mt-2!">{t("filtering.subtitle")}</p>
        </div>
        <Button
          icon={<RefreshCw size={16} />}
          text={t("filtering.syncAll")}
          onClick={syncLists}
          loading={syncing || loading}
          disabled={syncing || loading || lists.length === 0}
          className={isMobile ? "w-full" : ""}
        />
      </div>

      <Callout intent={Intent.WARNING} icon="info-sign" className="mb-6">
        <p>
          {t(
            "filtering.formatDisclaimer"
          )}
        </p>
      </Callout>

      <AddListCard
        newUrl={newUrl}
        setNewUrl={setNewUrl}
        onAddList={addList}
        syncing={syncing}
        loading={loading}
        lists={lists}
      />

      <ListsTable
        lists={lists}
        onSelect={setSelectedList}
        onToggleEnabled={setListEnabled}
        pendingIds={pendingToggleIds}
      />

      <ListDetailsDialog
        profileId={profileId}
        selectedList={selectedList}
        onClose={() => setSelectedList(null)}
        onCopy={copyToClipboard}
        onDelete={deleteList}
        onToggleEnabled={setListEnabled}
        onAllowDomain={allowDomain}
        onSyncSingle={handleSyncSingleList}
      />
    </div>
  );
};
