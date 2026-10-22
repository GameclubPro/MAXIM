import { z } from 'zod';
import {
  networkSettingsTargetSchema,
  networkChannelSettingsSectionSchema,
  networkChatSettingsSectionSchema,
  applySettingsSectionSchema,
} from '@maxim/contracts/network-settings-read';
import type { NetworkSettingsTarget } from '@maxim/contracts/network-settings-read';
import type { ManagedEntityType } from '@maxim/contracts/managed-entities';
import {
  readLocalMirrorItem,
  saveMirroredItem,
  removeMirroredItem,
  readNativeStorageItem,
  writeLocalMirrorItem,
} from './native-storage';

export type NetworkChannelSettingsSection = z.infer<typeof networkChannelSettingsSectionSchema>;
export const networkChatWorkspaceSectionSchema = z.union([
  applySettingsSectionSchema,
  networkChatSettingsSectionSchema,
]);
export type NetworkChatSettingsSection = z.infer<typeof networkChatWorkspaceSectionSchema>;
export type NetworkSettingsEditorScope =
  | {
      entityType: 'chat';
      target: NetworkSettingsTarget;
      initialSection: NetworkChatSettingsSection;
    }
  | {
      entityType: 'channel';
      target: NetworkSettingsTarget;
      initialSection: NetworkChannelSettingsSection;
    };
export interface NetworkSettingsWorkspaceOrigin {
  locationKey: string;
  historyIndex: number | null;
  scrollY: number;
  anchor?: { entityId: string; offset: number };
  loadedPageCount?: number;
}
export interface StoredNetworkSettingsScope {
  version: 1;
  scopeId: string;
  userId: string;
  scope: NetworkSettingsEditorScope;
  title: string;
  returnTo: string;
  origin?: NetworkSettingsWorkspaceOrigin;
  retryOfOperationId?: string;
  createdAt: string;
}
const scopeSchema = z
  .object({
    version: z.literal(1),
    scopeId: z.string().uuid(),
    userId: z.string().min(1).max(128),
    scope: z.discriminatedUnion('entityType', [
      z
        .object({
          entityType: z.literal('chat'),
          target: networkSettingsTargetSchema,
          initialSection: networkChatWorkspaceSectionSchema,
        })
        .strict(),
      z
        .object({
          entityType: z.literal('channel'),
          target: networkSettingsTargetSchema,
          initialSection: networkChannelSettingsSectionSchema,
        })
        .strict(),
    ]),
    title: z.string().max(256),
    retryOfOperationId: z.string().uuid().optional(),
    returnTo: z.string().regex(/^\/networks(?:\/(?:chat|channel))?(?:\?[^#]*)?$/),
    origin: z
      .object({
        locationKey: z.string().max(256),
        historyIndex: z.number().int().nonnegative().nullable(),
        scrollY: z.number().finite().nonnegative(),
        anchor: z
          .object({ entityId: z.string().min(1), offset: z.number().finite() })
          .strict()
          .optional(),
        loadedPageCount: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    createdAt: z.string().datetime(),
  })
  .strict();
export function networkSettingsScopeStorageKey(userId: string, scopeId: string): string {
  return 'maxim.network.settings.scope.v1:' + encodeURIComponent(userId) + ':' + scopeId;
}
function decode(
  raw: string | null,
  input: { userId: string; scopeId: string; entityType: ManagedEntityType },
): StoredNetworkSettingsScope | null {
  try {
    const value = scopeSchema.parse(JSON.parse(raw ?? 'null'));
    return value.userId === input.userId &&
      value.scopeId === input.scopeId &&
      value.scope.entityType === input.entityType
      ? structuredClone(value)
      : null;
  } catch {
    return null;
  }
}
export function createNetworkSettingsScope(
  input: Omit<StoredNetworkSettingsScope, 'version' | 'scopeId' | 'createdAt'>,
): StoredNetworkSettingsScope {
  const value = scopeSchema.parse({
    ...structuredClone(input),
    version: 1,
    scopeId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });
  const key = networkSettingsScopeStorageKey(value.userId, value.scopeId);
  saveMirroredItem(key, JSON.stringify(value));
  if (
    !decode(readLocalMirrorItem(key), {
      userId: value.userId,
      scopeId: value.scopeId,
      entityType: value.scope.entityType,
    })
  )
    throw new Error('Не удалось сохранить выбранные сообщества.');
  return structuredClone(value);
}
export function readNetworkSettingsScope(input: {
  userId: string;
  scopeId: string;
  entityType: ManagedEntityType;
}): StoredNetworkSettingsScope | null {
  return decode(
    readLocalMirrorItem(networkSettingsScopeStorageKey(input.userId, input.scopeId)),
    input,
  );
}
export function removeNetworkSettingsScope(input: { userId: string; scopeId: string }): void {
  // FLAG: Submitted/uncertain receipts outlive previews; their exact scope must survive too.
  const receipts = readLocalMirrorItem(
    'maxim.network.settings.receipts.v1:' + encodeURIComponent(input.userId),
  );
  try {
    if (
      (JSON.parse(receipts ?? '[]') as { scopeId?: unknown; launchState?: unknown }[]).some(
        (r) => r.scopeId === input.scopeId && r.launchState !== 'unconfirmed',
      )
    )
      return;
  } catch {
    return;
  }
  removeMirroredItem(networkSettingsScopeStorageKey(input.userId, input.scopeId));
}
export async function hydrateNetworkSettingsScope(input: {
  userId: string;
  scopeId: string;
  entityType: ManagedEntityType;
}): Promise<StoredNetworkSettingsScope | null> {
  const local = readNetworkSettingsScope(input);
  if (local) return local;
  const key = networkSettingsScopeStorageKey(input.userId, input.scopeId);
  const native = decode(await readNativeStorageItem(key), input);
  const newer = readNetworkSettingsScope(input);
  if (newer) return newer;
  if (native) writeLocalMirrorItem(key, JSON.stringify(native));
  return native;
}
