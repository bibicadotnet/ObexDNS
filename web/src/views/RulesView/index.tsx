import React, { useState, useEffect } from "react";
import { Callout, Intent, ButtonGroup, Button, Spinner } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import type { Rule, RulesViewProps, ProfileSettings } from "./types";
import { AddRuleCard } from "./components/AddRuleCard";
import { RulesTable } from "./components/RulesTable";
import { EditRuleDialog } from "./components/EditRuleDialog";
import { useIsMobile } from "../../hooks/useIsMobile";
import { PageHeader } from "../../components/PageHeader";
import {
  getProfileRules,
  getProfileDetails,
  addProfileRule,
  updateProfileRule,
  deleteProfileRule,
  toggleProfileRule,
} from "../../services";

export const RulesView: React.FC<RulesViewProps> = ({ profileId, prefill, onPrefillUsed, toasterRef }) => {
  const navigate = useNavigate();
  const [rules, setRules] = useState<Rule[]>([]);
  const [settings, setSettings] = useState<ProfileSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [pendingToggleIds, setPendingToggleIds] = useState<Set<number>>(new Set());
  const pendingToggles = React.useRef(0);
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [newRule, setNewRule] = useState<{
    type: Rule["type"];
    pattern: string;
    include_subdomains?: boolean;
    v_a: string;
    v_aaaa: string;
    v_txt: string;
    v_cname: string;
  }>({
    type: "BLOCK",
    pattern: "",
    include_subdomains: false,
    v_a: "",
    v_aaaa: "",
    v_txt: "",
    v_cname: "",
  });

  const [editRule, setEditRule] = useState<Rule | null>(null);
  useEffect(() => {
    if (prefill) {
      setNewRule({
        type: prefill.type,
        pattern: prefill.domain,
        include_subdomains: false,
        v_a: prefill.recordType === "A" ? "0.0.0.0" : "",
        v_aaaa: prefill.recordType === "AAAA" ? "::" : "",
        v_txt: prefill.recordType === "TXT" ? "Pre-filled" : "",
        v_cname: prefill.recordType === "CNAME" ? "target.com" : "",
      });
      onPrefillUsed?.();
    }
  }, [prefill, onPrefillUsed]);

  const fetchRules = async () => {
    setLoading(true);
    try {
      const [rulesData, profileData] = await Promise.all([
        getProfileRules(profileId),
        getProfileDetails(profileId),
      ]);

      setRules(rulesData);
      setSettings(JSON.parse(profileData.settings || "{}"));
    } catch (e) {
      console.error("Failed to fetch data", e);
    } finally {
      setLoading(false);
    }
  };

  const getBlockDetail = () => {
    if (!settings) return t("rules.detailBlock");
    const mode = settings.block_mode || "NULL_IP";
    switch (mode) {
      case "NXDOMAIN":
        return "NXDOMAIN";
      case "NODATA":
        return "NODATA";
      case "CUSTOM_IP":
        return `${settings.custom_block_ipv4 || "0.0.0.0"} / ${settings.custom_block_ipv6 || "::"}`;
      default:
        return "0.0.0.0 / ::";
    }
  };

  const addRule = async () => {
    const trimmedPattern = newRule.pattern.trim();
    if (!trimmedPattern) {
      toasterRef?.current?.show({
        message: t("rules.patternEmpty", "Domain pattern cannot be empty"),
        intent: Intent.DANGER,
      });
      return;
    }
    const normalizedPattern = trimmedPattern.toLowerCase();
    if (rules.some(r => r.pattern.trim().toLowerCase() === normalizedPattern)) {
      toasterRef?.current?.show({
        message: t("rules.duplicatePattern", "Rule for this domain already exists"),
        intent: Intent.DANGER,
      });
      return;
    }
    setIsAdding(true);
    try {
      await addProfileRule(profileId, {
        ...newRule,
        pattern: trimmedPattern,
        include_subdomains: 0,
      });
      toasterRef?.current?.show({
        message: t("rules.addSuccess", "Rule added successfully"),
        intent: Intent.SUCCESS,
      });
      // Keep the chosen action so several rules of the same type can be added in a row;
      // only the per-rule fields are cleared.
      setNewRule((prev) => ({
        type: prev.type,
        pattern: "",
        include_subdomains: false,
        v_a: "",
        v_aaaa: "",
        v_txt: "",
        v_cname: "",
      }));
      await fetchRules();
    } catch (e: any) {
      toasterRef?.current?.show({
        message: e.message || t("rules.addFailed", "Failed to add rule"),
        intent: Intent.DANGER,
      });
    } finally {
      setIsAdding(false);
    }
  };

  const saveEditRule = async () => {
    if (!editRule) return;
    const trimmedPattern = editRule.pattern.trim();
    if (!trimmedPattern) {
      toasterRef?.current?.show({
        message: t("rules.patternEmpty", "Domain pattern cannot be empty"),
        intent: Intent.DANGER,
      });
      return;
    }
    const normalizedPattern = trimmedPattern.toLowerCase();
    if (rules.some(r => r.id !== editRule.id && r.pattern.trim().toLowerCase() === normalizedPattern)) {
      toasterRef?.current?.show({
        message: t("rules.duplicatePattern", "Rule for this domain already exists"),
        intent: Intent.DANGER,
      });
      return;
    }
    setIsSaving(true);
    try {
      await updateProfileRule(profileId, {
        ...editRule,
        pattern: trimmedPattern,
        include_subdomains: 0,
        enabled: editRule.enabled !== false && (editRule.enabled as any) !== 0,
      } as Rule);
      toasterRef?.current?.show({
        message: t("rules.updateSuccess", "Rule updated successfully"),
        intent: Intent.SUCCESS,
      });
      setEditRule(null);
      await fetchRules();
    } catch (e: any) {
      toasterRef?.current?.show({
        message: e.message || t("rules.updateFailed", "Failed to update rule"),
        intent: Intent.DANGER,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const cancelEdit = () => {
    setEditRule(null);
  };

  const startEdit = (rule: Rule) => {
    setEditRule({
      ...rule,
      enabled: rule.enabled !== false && (rule.enabled as any) !== 0,
      include_subdomains: rule.include_subdomains === 1 || rule.include_subdomains === true,
    });
  };

  const setRuleEnabled = async (id: number, enabled: boolean) => {
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, enabled } : r)));
    setEditRule((prev) => (prev && prev.id === id ? { ...prev, enabled } : prev));
    setPendingToggleIds((prev) => new Set(prev).add(id));
    pendingToggles.current++;
    try {
      await toggleProfileRule(profileId, id, enabled);
      toasterRef?.current?.show({
        message: enabled
          ? t("rules.ruleEnabledToast", "Rule enabled")
          : t("rules.ruleDisabledToast", "Rule disabled"),
        intent: Intent.PRIMARY,
        icon: enabled ? "tick" : "disable",
      });
    } catch (e) {
      console.error(e);
      setRules((prev) => prev.map((r) => (r.id === id ? { ...r, enabled: !enabled } : r)));
      setEditRule((prev) => (prev && prev.id === id ? { ...prev, enabled: !enabled } : prev));
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
      if (pendingToggles.current === 0) await fetchRules();
    }
  };

  const deleteRule = async (id: number) => {
    setIsDeleting(true);
    try {
      await deleteProfileRule(profileId, id);
    } catch (e) {
      console.error(e);
    } finally {
      setIsDeleting(false);
    }
    setEditRule(null);
    await fetchRules();
  };

  useEffect(() => {
    fetchRules();
  }, [profileId]);

  return (
    <div className="w-full min-w-0 max-w-5xl mx-auto px-1 md:px-8 space-y-6 pb-24">
      <PageHeader
        title={t("rules.title")}
        subtitle={t("rules.subtitle")}
        titleExtra={loading && !isMobile ? <Spinner size={20} /> : undefined}
        switcher={
          isMobile ? (
            <div className="flex items-center gap-2">
              <ButtonGroup minimal fill className="flex-1">
                <Button
                  active={true}
                  onClick={() => navigate(`/dash/${profileId}/rules`)}
                  text={t("rules.title")}
                  large
                />
                <Button
                  active={false}
                  onClick={() => navigate(`/dash/${profileId}/filter`)}
                  text={t("filtering.title")}
                  large
                />
              </ButtonGroup>
              {loading && <Spinner size={16} />}
            </div>
          ) : undefined
        }
      />

      <Callout intent={Intent.PRIMARY} icon="info-sign" className="mb-6">
        <p>
          {t(
            "rules.wildcardDisclaimer",
            "Adblock-style syntax is supported: example.com (exact), ||example.com^ or *.example.com (with subdomains), * wildcards and /regex/."
          )}
        </p>
      </Callout>

      <AddRuleCard newRule={newRule} setNewRule={setNewRule} addRule={addRule} loading={isAdding} />

      {loading && rules.length === 0 ? (
        <div className="p-16 flex flex-col justify-center items-center gap-3">
          <Spinner size={32} />
          <span className="text-xs text-gray-500 font-medium">
            {t("common.loading", "Loading...")}
          </span>
        </div>
      ) : rules.length === 0 ? (
        <Callout title={t("rules.noRulesTitle")}>{t("rules.noRulesDesc")}</Callout>
      ) : (
        <div className="relative">
          {loading && (
            <div className="absolute inset-0 bg-white/40 backdrop-blur-xs flex items-center justify-center z-10 rounded-lg">
              <Spinner size={32} />
            </div>
          )}
          <RulesTable
            rules={rules}
            startEdit={startEdit}
            getBlockDetail={getBlockDetail}
            onToggleEnabled={setRuleEnabled}
            pendingIds={pendingToggleIds}
          />
        </div>
      )}

      <EditRuleDialog
        editRule={editRule}
        setEditRule={setEditRule}
        saveEditRule={saveEditRule}
        cancelEdit={cancelEdit}
        deleteRule={deleteRule}
        isSaving={isSaving}
        isDeleting={isDeleting}
      />
    </div>
  );
};
