import React from "react";
import { Card, Elevation, InputGroup, Button, PopoverNext, Intent, Menu, MenuItem, MenuDivider, Tag } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import { usePresetLists } from "../hooks";
import type {  FilterList  } from "../types";

export interface AddListCardProps {
  newUrl: string;
  setNewUrl: (url: string) => void;
  onAddList: (url?: string) => void;
  syncing: boolean;
  loading: boolean;
  lists: FilterList[];
}

export const AddListCard: React.FC<AddListCardProps> = ({ newUrl, setNewUrl, onAddList, syncing, loading, lists }) => {
  const { t } = useTranslation();
  const PRESET_LISTS = usePresetLists();

  const renderPreset = (preset: (typeof PRESET_LISTS)[number]) => {
    const description = preset.description?.trim();
    const added = lists.some((l) => l.url === preset.url);
    return (
      <MenuItem
        key={preset.url}
        multiline
        onClick={() => onAddList(preset.url)}
        disabled={added}
        // The source URL is not shown here: it is visible in the list details once added.
        title={preset.url}
        text={
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-medium truncate">{preset.label}</span>
              {added && (
                <Tag minimal className="shrink-0">
                  {t("filtering.added", "Added")}
                </Tag>
              )}
            </div>
            {description && (
              <div className="text-xs opacity-70 line-clamp-3 break-words whitespace-normal">{description}</div>
            )}
          </div>
        }
      />
    );
  };

  // Recommended lists first. Headings only appear when both groups exist, otherwise they add noise.
  const recommended = PRESET_LISTS.filter((p) => p.is_default);
  const others = PRESET_LISTS.filter((p) => !p.is_default);
  const grouped = recommended.length > 0 && others.length > 0;

  const presetMenu = (
    <Menu className="w-[32rem] max-w-[90vw]">
      {grouped ? (
        <>
          <MenuDivider title={t("filtering.groupRecommended", "Recommended")} />
          {recommended.map(renderPreset)}
          <MenuDivider title={t("filtering.groupOther", "Other lists")} />
          {others.map(renderPreset)}
        </>
      ) : (
        PRESET_LISTS.map(renderPreset)
      )}
    </Menu>
  );

  return (
    <Card elevation={Elevation.ONE} className="mb-6">
      <div className="flex gap-2 flex-col sm:flex-row">
        <InputGroup
          fill
          size="large"
          placeholder={t("filtering.urlPlaceholder")}
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
          leftIcon="globe"
          rightElement={
            <PopoverNext content={presetMenu} placement="bottom-end" animation="minimal" arrow={false} usePortal={true}>
              <Button variant="minimal" icon="chevron-down" />
            </PopoverNext>
          }
        />
        <Button
          intent={Intent.PRIMARY}
          size="large"
          icon="plus"
          onClick={() => onAddList()}
          className="shrink-0"
          loading={syncing || loading}
          disabled={syncing || loading}
        >
          {t("filtering.addSubscription")}
        </Button>
      </div>
    </Card>
  );
};
