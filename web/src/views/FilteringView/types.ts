import { OverlayToaster } from "@blueprintjs/core";
import React from "react";

export interface FilteringViewProps {
  profileId: string;
  toasterRef?: React.RefObject<OverlayToaster | null>;
}

export interface FilterList {
  id: number;
  url: string;
  last_synced_at?: number;
  enabled: boolean;
  sync_error?: string | null;
  /** Display name: admin label for preset lists, otherwise the `! Title:` parsed from the list header. */
  title?: string | null;
  /** Short explanation of the list, parsed from its `! Description:` header (empty/absent when the list has none). */
  description?: string | null;
  /** True for lists the admin configured as recommended defaults (DEFAULT_PROFILE_FILTER_URLS). */
  is_default?: boolean;
  /** True for lists provided by the admin (SYSTEM_FILTER_URLS / DEFAULT_PROFILE_FILTER_URLS); false for user-added URLs. */
  is_system?: boolean;
}
