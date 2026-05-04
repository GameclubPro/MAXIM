import type { BroadcastLinkButton, BroadcastTargetMode } from '@maxim/contracts';
import type { BroadcastQuickPreset } from './broadcast-schedule';
import type { BroadcastScopedTargetMode } from './broadcast-audience';

export type BroadcastComposerDraftEntityType = 'chat' | 'channel';

export type BroadcastComposerDraft = {
  text: string;
  targetMode: BroadcastTargetMode;
  targetChatIds: string[];
  lastScopedTargetMode: BroadcastScopedTargetMode;
  buttons: BroadcastLinkButton[];
  imageEnabled: boolean;
  imageBase64: string;
  imageMimeType: string;
  imageFileName: string;
  scheduledSlots: string[];
  quickPreset: BroadcastQuickPreset | null;
  scheduleTimezone: string;
};

const STORAGE_VERSION = 1;

function getStorageKey(entityType: BroadcastComposerDraftEntityType, entityId: string): string {
  return `maxim:broadcast-composer:${entityType}:${entityId}`;
}

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function readTargetMode(value: unknown, fallback: BroadcastTargetMode): BroadcastTargetMode {
  return value === 'all' || value === 'selected' || value === 'current' ? value : fallback;
}

function readScopedMode(
  value: unknown,
  fallback: BroadcastScopedTargetMode,
): BroadcastScopedTargetMode {
  return value === 'selected' || value === 'current' ? value : fallback;
}

function readQuickPreset(value: unknown): BroadcastQuickPreset | null {
  return value === 'now' || value === 'plus30' || value === 'tonight' || value === 'tomorrow'
    ? value
    : null;
}

function readButtons(value: unknown): BroadcastLinkButton[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!isObject(item)) {
        return null;
      }

      return {
        text: readString(item.text),
        url: readString(item.url),
      };
    })
    .filter((item): item is BroadcastLinkButton => item !== null);
}

export function loadBroadcastComposerDraft(
  entityType: BroadcastComposerDraftEntityType,
  entityId: string,
): BroadcastComposerDraft | null {
  if (!entityId || !canUseStorage()) {
    return null;
  }

  try {
    const rawValue = window.localStorage.getItem(getStorageKey(entityType, entityId));
    if (!rawValue) {
      return null;
    }

    const parsed: unknown = JSON.parse(rawValue);
    if (!isObject(parsed) || parsed.version !== STORAGE_VERSION || !isObject(parsed.draft)) {
      return null;
    }

    const draft = parsed.draft;
    return {
      text: readString(draft.text),
      targetMode: readTargetMode(draft.targetMode, 'current'),
      targetChatIds: readStringArray(draft.targetChatIds),
      lastScopedTargetMode: readScopedMode(draft.lastScopedTargetMode, 'current'),
      buttons: readButtons(draft.buttons),
      imageEnabled: draft.imageEnabled === true,
      imageBase64: readString(draft.imageBase64),
      imageMimeType: readString(draft.imageMimeType),
      imageFileName: readString(draft.imageFileName),
      scheduledSlots: readStringArray(draft.scheduledSlots),
      quickPreset: readQuickPreset(draft.quickPreset),
      scheduleTimezone: readString(draft.scheduleTimezone),
    };
  } catch {
    return null;
  }
}

export function isBroadcastComposerDraftEmpty(draft: BroadcastComposerDraft): boolean {
  return (
    !draft.text.trim() &&
    draft.targetMode === 'current' &&
    draft.targetChatIds.length <= 1 &&
    draft.lastScopedTargetMode === 'current' &&
    draft.buttons.length === 0 &&
    !draft.imageEnabled &&
    draft.scheduledSlots.length === 0 &&
    draft.quickPreset === null
  );
}

export function saveBroadcastComposerDraft(
  entityType: BroadcastComposerDraftEntityType,
  entityId: string,
  draft: BroadcastComposerDraft,
): void {
  if (!entityId || !canUseStorage()) {
    return;
  }

  try {
    const key = getStorageKey(entityType, entityId);
    if (isBroadcastComposerDraftEmpty(draft)) {
      window.localStorage.removeItem(key);
      return;
    }

    window.localStorage.setItem(
      key,
      JSON.stringify({
        version: STORAGE_VERSION,
        savedAt: new Date().toISOString(),
        draft,
      }),
    );
  } catch {
    // Storage can be unavailable or quota-limited inside a WebView.
  }
}
