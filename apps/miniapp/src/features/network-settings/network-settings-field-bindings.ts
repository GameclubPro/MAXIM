import type {
  NetworkSettingsChange,
  NetworkSettingsField,
  NetworkSettingsSection,
} from '@maxim/contracts/network-settings';
import type { SettingsFieldAdapter, FieldPath, SettingsFieldState } from './field-model';
import { parseSettingsField, settingsSectionPaths } from './field-registry';
import { canonicalNetworkValue } from './network-settings-operation-state';

export function createNetworkSettingsFieldAdapter<T>(options: {
  entityType: 'chat' | 'channel';
  section: NetworkSettingsSection;
  fields: Readonly<Record<string, NetworkSettingsField>>;
  changes: readonly NetworkSettingsChange[];
  errors: Readonly<Record<string, string>>;
  readOnly: boolean;
  onChanges: (changes: NetworkSettingsChange[]) => void;
  onError: (path: string, error: string | null) => void;
}): SettingsFieldAdapter<T> {
  const paths = new Set(settingsSectionPaths(options.entityType, options.section));
  const changes = new Map(options.changes.map((change) => [change.path, change]));
  const apply = (incoming: readonly NetworkSettingsChange[]) => {
    if (options.readOnly) return;
    const next = new Map(changes);
    // FLAG: A dependency bundle is validated completely before publishing any intent.
    for (const change of incoming) {
      if (!paths.has(change.path)) throw new Error('Поле не входит в раздел.');
      if (change.op === 'clear') {
        if (
          !change.path.startsWith('botSpeechMedia.') &&
          !change.path.startsWith('stopWordsPolicy.sanctions.media.') &&
          change.path !== 'rules.imageBase64'
        )
          throw new Error('Удалять можно только выбранное изображение.');
      } else {
        if (Array.isArray(change.value) !== (change.op === 'replace'))
          throw new Error('Для списка требуется явная замена.');
        parseSettingsField(options.entityType, options.section, change.path, change.value);
      }
      const baseline = options.fields[change.path];
      const value = change.op === 'clear' ? null : change.value;
      if (
        baseline?.kind === 'common' &&
        canonicalNetworkValue(baseline.value) === canonicalNetworkValue(value)
      )
        next.delete(change.path);
      else next.set(change.path, structuredClone(change));
    }
    options.onChanges([...next.values()]);
  };
  return {
    read: <K extends FieldPath<T>>(path: K): SettingsFieldState<T[K]> => {
      if (!paths.has(path)) return { kind: 'loading' };
      const change = changes.get(path);
      if (change)
        return {
          kind: 'common',
          value: (change.op === 'clear' ? null : structuredClone(change.value)) as T[K],
        };
      const field = options.fields[path];
      return field?.kind === 'common'
        ? { kind: 'common', value: structuredClone(field.value) as T[K] }
        : (field ?? { kind: 'loading' });
    },
    setScalar: (path, value) => apply([{ op: 'set', path, value }]),
    replaceList: (path, value) => apply([{ op: 'replace', path, value: value as unknown[] }]),
    clearMedia: (path) => apply([{ op: 'clear', path }]),
    revert: (path) => {
      if (options.readOnly) return;
      const next = new Map(changes);
      next.delete(path);
      options.onError(path, null);
      options.onChanges([...next.values()]);
    },
    transact: apply,
    isDirty: (path) => (path ? changes.has(path) : changes.size > 0),
    error: (path) => options.errors[path] ?? null,
    setError: options.onError,
    readOnly: options.readOnly,
  };
}
