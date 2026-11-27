import { OverlayToaster } from "@blueprintjs/core";

export interface Rule {
  id: number;
  type: "ALLOW" | "BLOCK" | "REDIRECT";
  pattern: string;
  include_subdomains?: boolean | number;
  v_a?: string;
  v_aaaa?: string;
  v_txt?: string;
  v_cname?: string;
  created_at?: number;
  enabled?: boolean | number;
}

export interface RulesTableProps {
  rules: Rule[];
  startEdit: (rule: Rule) => void;
  getBlockDetail: () => string;
  onToggleEnabled?: (id: number, enabled: boolean) => void;
  pendingIds?: Set<number>;
}

export interface RulesViewProps {
  profileId: string;
  prefill?: {
    domain: string;
    type: "ALLOW" | "BLOCK" | "REDIRECT";
    recordType?: string;
  } | null;
  onPrefillUsed?: () => void;
  toasterRef?: React.RefObject<OverlayToaster | null>;
}

export interface ProfileSettings {
  block_mode?: "NULL_IP" | "NXDOMAIN" | "NODATA" | "CUSTOM_IP";
  custom_block_ipv4?: string;
  custom_block_ipv6?: string;
}
