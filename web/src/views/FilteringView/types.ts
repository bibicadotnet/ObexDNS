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
}
