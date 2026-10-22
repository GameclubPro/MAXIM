import type { ChannelSettings } from '@maxim/contracts/settings';
import type { ChannelPostSignatureSettings } from '@maxim/contracts/channel-post-signature';
import type { ChannelSettingsFieldAdapter } from './field-model';
import type { ChatSettings } from '@maxim/contracts/settings';
import type { NetworkSettingsChange } from '@maxim/contracts/network-settings';
import type { ChatSettingsFieldAdapter } from './field-model';
import { readSettingsPath, writeSettingsPath } from './field-model';

export function createChatSettingsFieldAdapter(options: {
  settings: ChatSettings;
  onChange: (next: ChatSettings) => void;
  baseline?: ChatSettings;
  readOnly?: boolean;
  errors?: Partial<Record<string, string>>;
  onError?: (path: string, error: string | null) => void;
}): ChatSettingsFieldAdapter {
  const apply = (changes: readonly NetworkSettingsChange[]) => {
    if (options.readOnly) return;
    const next = structuredClone(options.settings);
    for (const change of changes)
      writeSettingsPath(
        next,
        change.path,
        change.op === 'clear' ? undefined : change.value,
        change.op === 'clear',
      );
    options.onChange(next);
  };
  return {
    read: (path) => ({
      kind: 'common',
      value: (readSettingsPath(options.settings, path) ?? null) as never,
    }),
    setScalar: (path, value) => apply([{ op: 'set', path, value }]),
    replaceList: (path, value) => apply([{ op: 'replace', path, value: value as unknown[] }]),
    clearMedia: (path) => apply([{ op: 'clear', path }]),
    revert: (path) => {
      const value = readSettingsPath(options.baseline ?? options.settings, path);
      apply([
        Array.isArray(value)
          ? { op: 'replace', path, value }
          : value === undefined
            ? { op: 'clear', path }
            : { op: 'set', path, value },
      ]);
    },
    transact: apply,
    isDirty: (path) =>
      path
        ? JSON.stringify(readSettingsPath(options.settings, path)) !==
          JSON.stringify(readSettingsPath(options.baseline ?? options.settings, path))
        : JSON.stringify(options.settings) !== JSON.stringify(options.baseline ?? options.settings),
    error: (path) => options.errors?.[path] ?? null,
    setError: (path, error) => options.onError?.(path, error),
    readOnly: options.readOnly ?? false,
  };
}
export function createChannelSettingsFieldAdapter<
  T extends ChannelSettings | ChannelPostSignatureSettings,
>(options: {
  settings: T;
  onChange: (next: T, changedPaths: string[]) => void;
  baseline?: T;
  readOnly?: boolean;
  errors?: Partial<Record<string, string>>;
  onError?: (path: string, error: string | null) => void;
}): ChannelSettingsFieldAdapter {
  const apply = (changes: readonly NetworkSettingsChange[]) => {
    if (options.readOnly) return;
    const next = structuredClone(options.settings);
    for (const change of changes)
      writeSettingsPath(
        next,
        change.path,
        change.op === 'clear' ? undefined : change.value,
        change.op === 'clear',
      );
    options.onChange(
      next,
      changes.map((c) => c.path),
    );
  };
  return {
    read: (path) => {
      const value = readSettingsPath(options.settings, path);
      return value === undefined ? { kind: 'loading' } : { kind: 'common', value: value as never };
    },
    setScalar: (path, value) => apply([{ op: 'set', path, value }]),
    replaceList: (path, value) => apply([{ op: 'replace', path, value: value as unknown[] }]),
    clearMedia: (path) => apply([{ op: 'clear', path }]),
    revert: (path) => {
      const value = readSettingsPath(options.baseline ?? options.settings, path);
      apply([
        Array.isArray(value)
          ? { op: 'replace', path, value }
          : value === undefined
            ? { op: 'clear', path }
            : { op: 'set', path, value },
      ]);
    },
    transact: apply,
    isDirty: (path) =>
      JSON.stringify(path ? readSettingsPath(options.settings, path) : options.settings) !==
      JSON.stringify(
        path
          ? readSettingsPath(options.baseline ?? options.settings, path)
          : (options.baseline ?? options.settings),
      ),
    error: (path) => options.errors?.[path] ?? null,
    setError: (path, error) => options.onError?.(path, error),
    readOnly: options.readOnly ?? false,
  };
}
