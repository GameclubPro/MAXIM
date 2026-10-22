import type { NetworkSettingsChange } from '@maxim/contracts/network-settings';
import type {
  BotSpeechMedia,
  BotSpeechMediaImage,
  ChannelSettings,
  ChatSettings,
  ChatRules,
} from '@maxim/contracts/settings';
import type { ChannelPostSignatureSettings } from '@maxim/contracts/channel-post-signature';
import type { StopWordsPolicy } from '@maxim/contracts/settings';

export type SettingsFieldState<T> =
  | { kind: 'loading' }
  | { kind: 'common'; value: T }
  | { kind: 'mixed' };

type StopPolicy = StopWordsPolicy;
type StopSanctions = StopPolicy['sanctions'];
type Prefixed<T, P extends string> = { [K in keyof T & string as `${P}.${K}`]: T[K] };
export type ChatSettingsFieldValues = Omit<ChatSettings, 'botSpeechMedia' | 'stopWordsPolicy'> &
  Prefixed<
    Pick<
      ChatRules,
      | 'text'
      | 'textFormat'
      | 'autoTextEnabled'
      | 'imageBase64'
      | 'imageMimeType'
      | 'imageFileName'
      | 'buttons'
      | 'buttonEnabled'
      | 'adminContactButtonEnabled'
      | 'adminContactButtonUrl'
    >,
    'rules'
  > & {
    'messageRetention.enabled': boolean;
    'messageRetention.hours': 24 | 48;
    'advertising.enabled': boolean;
  } & Prefixed<Omit<StopPolicy, 'version' | 'sanctions'>, 'stopWordsPolicy'> &
  Prefixed<Omit<StopSanctions, 'media'>, 'stopWordsPolicy.sanctions'> & {
    [K in keyof BotSpeechMedia & string as `botSpeechMedia.${K}`]: BotSpeechMediaImage | null;
  } & {
    'stopWordsPolicy.sanctions.media.explanation': NonNullable<
      StopSanctions['media']['explanation']
    > | null;
    'stopWordsPolicy.sanctions.media.warning': NonNullable<
      StopSanctions['media']['warning']
    > | null;
  };
export type ChannelSettingsFieldValues = Omit<ChannelSettings, 'revision'> &
  Omit<ChannelPostSignatureSettings, 'revision'>;
export type FieldPath<T> = keyof T & string;
export type ListFieldPath<T> = {
  [K in FieldPath<T>]: T[K] extends readonly unknown[] ? K : never;
}[FieldPath<T>];
export type ScalarFieldPath<T> = Exclude<FieldPath<T>, ListFieldPath<T>>;
export type ChatSettingsFieldPath = FieldPath<ChatSettingsFieldValues>;
export type ChatScalarFieldPath = ScalarFieldPath<ChatSettingsFieldValues>;
export type ChatListFieldPath = ListFieldPath<ChatSettingsFieldValues>;
export type ChatMediaFieldPath = Extract<
  ChatSettingsFieldPath,
  `botSpeechMedia.${string}` | `stopWordsPolicy.sanctions.media.${string}`
>;

export interface SettingsFieldAdapter<T> {
  read<K extends FieldPath<T>>(path: K): SettingsFieldState<T[K]>;
  setScalar<K extends ScalarFieldPath<T>>(path: K, value: T[K]): void;
  replaceList<K extends ListFieldPath<T>>(path: K, value: T[K]): void;
  clearMedia(
    path: Extract<
      FieldPath<T>,
      `botSpeechMedia.${string}` | `stopWordsPolicy.sanctions.media.${string}`
    >,
  ): void;
  revert(path: FieldPath<T>): void;
  transact(changes: readonly NetworkSettingsChange[]): void;
  isDirty(path?: FieldPath<T>): boolean;
  error(path: FieldPath<T>): string | null;
  setError(path: FieldPath<T>, error: string | null): void;
  readonly readOnly: boolean;
}
export type ChatSettingsFieldAdapter = SettingsFieldAdapter<ChatSettingsFieldValues>;
export type ChannelSettingsFieldAdapter = SettingsFieldAdapter<ChannelSettingsFieldValues>;

export function readSettingsPath(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === 'object' && !Array.isArray(current)
          ? (current as Record<string, unknown>)[key]
          : undefined,
      value,
    );
}
export function writeSettingsPath(value: object, path: string, next: unknown, clear = false): void {
  const keys = path.split('.');
  if (keys.some((key) => ['__proto__', 'constructor', 'prototype'].includes(key)))
    throw new Error('Недопустимое поле настроек.');
  let parent = value as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    if (!parent[key] || typeof parent[key] !== 'object' || Array.isArray(parent[key]))
      parent[key] = {};
    parent = parent[key] as Record<string, unknown>;
  }
  const leaf = keys.at(-1)!;
  if (clear) delete parent[leaf];
  else parent[leaf] = structuredClone(next);
}
