import { z } from 'zod';
import { managedEntityTypeSchema } from '@maxim/contracts/managed-entities';
import {
  networkSettingsSectionSchema,
  networkSettingsOperationStatusSchema,
} from '@maxim/contracts/network-settings-read';
import {
  isNativeDeviceStorageAvailable,
  readLocalMirrorItem,
  readNativeStorageItemState,
  writeLocalMirrorItem,
  writeNativeStorageItem,
} from './native-storage';
import { networkSettingsScopeStorageKey } from './network-settings-workspace-state';
const receiptSchema = z
  .object({
    version: z.literal(1),
    scopeId: z.string().uuid(),
    userId: z.string().min(1).max(128),
    entityType: managedEntityTypeSchema,
    section: networkSettingsSectionSchema,
    title: z.string().max(256),
    operationId: z.string().uuid(),
    launchState: z.enum(['unconfirmed', 'launching', 'submitted', 'uncertain']),
    lastKnownStatus: networkSettingsOperationStatusSchema.optional(),
    updatedAt: z.string().datetime(),
    expiresAt: z.string().datetime().optional(),
    recipientIds: z
      .array(z.string().min(1))
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
    completionConfirmedAt: z.string().datetime().optional(),
    previewHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type NetworkSettingsOperationReceipt = z.infer<typeof receiptSchema>;
const key = (userId: string) => 'maxim.network.settings.receipts.v1:' + encodeURIComponent(userId);
const queues = new Map<string, Promise<unknown>>();
const RECEIPT_LIMIT = 100;
type OperationStatus = NetworkSettingsOperationReceipt['lastKnownStatus'];
const STATUS_RANK = {
  PREVIEWING: 0,
  PREPARED: 1,
  AUTHORIZING: 2,
  RUNNING: 3,
  COMPLETE: 4,
  PARTIAL: 4,
  FAILED: 4,
} as const;
export function mergeNetworkSettingsOperationStatus(
  previous: OperationStatus,
  next: OperationStatus,
): OperationStatus {
  if (!previous) return next;
  if (!next) return previous;
  return STATUS_RANK[previous] >= STATUS_RANK[next] ? previous : next;
}
function pruneCompletedReceipts(
  values: NetworkSettingsOperationReceipt[],
  protectOperationId?: string,
) {
  const sorted = [...values].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  let excess = Math.max(0, sorted.length - RECEIPT_LIMIT);
  const remove = new Set<string>();
  for (const row of [...sorted].reverse()) {
    // FLAG: Only an exact COMPLETE response with all recipients complete can release history space.
    if (
      excess &&
      row.operationId !== protectOperationId &&
      row.launchState === 'submitted' &&
      row.lastKnownStatus === 'COMPLETE' &&
      row.completionConfirmedAt &&
      row.recipientIds?.length
    ) {
      remove.add(row.operationId);
      excess--;
    }
  }
  return sorted.filter((row) => !remove.has(row.operationId));
}
function decode(userId: string, raw: string | null): NetworkSettingsOperationReceipt[] {
  try {
    const values: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(values)) return [];
    return values
      .flatMap((v) => {
        const p = receiptSchema.safeParse(v);
        return p.success && p.data.userId === userId ? [p.data] : [];
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}
export function listNetworkSettingsOperationReceipts(
  userId: string,
): NetworkSettingsOperationReceipt[] {
  return structuredClone(decode(userId, readLocalMirrorItem(key(userId))));
}
function merge(
  userId: string,
  a: NetworkSettingsOperationReceipt[],
  b: NetworkSettingsOperationReceipt[],
) {
  const merged = new Map<string, NetworkSettingsOperationReceipt>();
  for (const row of [...a, ...b]) {
    const old = merged.get(row.operationId);
    if (row.userId !== userId) continue;
    try {
      merged.set(row.operationId, mergeNetworkSettingsReceipt(old, row));
    } catch {
      // FLAG: A conflicting native copy cannot replace an operation's existing actor/scope binding.
    }
  }
  return [...merged.values()].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
}
export async function hydrateNetworkSettingsOperationReceipts(
  userId: string,
): Promise<NetworkSettingsOperationReceipt[]> {
  const previous = queues.get(userId) ?? Promise.resolve();
  const work = previous
    .catch(() => undefined)
    .then(async () => {
      const native = await readNativeStorageItemState(key(userId));
      const values = pruneCompletedReceipts(
        merge(
          userId,
          listNetworkSettingsOperationReceipts(userId),
          native.status === 'found' ? decode(userId, native.value) : [],
        ),
      );
      writeLocalMirrorItem(key(userId), JSON.stringify(values));
      return structuredClone(values);
    });
  queues.set(userId, work);
  try {
    return await work;
  } finally {
    if (queues.get(userId) === work) queues.delete(userId);
  }
}
export function mergeNetworkSettingsReceipt(
  previous: NetworkSettingsOperationReceipt | undefined,
  next: NetworkSettingsOperationReceipt,
): NetworkSettingsOperationReceipt {
  if (!previous || previous.operationId !== next.operationId) return next;
  if (
    previous.userId !== next.userId ||
    previous.scopeId !== next.scopeId ||
    previous.entityType !== next.entityType ||
    previous.section !== next.section
  )
    throw new Error('Номер операции уже связан с другим выбором.');
  if (
    (previous.previewHash && next.previewHash && previous.previewHash !== next.previewHash) ||
    (previous.recipientIds &&
      next.recipientIds &&
      JSON.stringify([...previous.recipientIds].sort()) !==
        JSON.stringify([...next.recipientIds].sort()))
  )
    throw new Error('Получатели или предпросмотр операции уже зафиксированы.');
  const launchRank = { unconfirmed: 0, launching: 1, uncertain: 2, submitted: 3 } as const;
  const latest = previous.updatedAt > next.updatedAt ? previous : next;
  return {
    ...previous,
    ...latest,
    launchState:
      launchRank[previous.launchState] >= launchRank[next.launchState]
        ? previous.launchState
        : next.launchState,
    lastKnownStatus: mergeNetworkSettingsOperationStatus(
      previous.lastKnownStatus,
      next.lastKnownStatus,
    ),
    ...(previous.recipientIds || next.recipientIds
      ? { recipientIds: previous.recipientIds ?? next.recipientIds }
      : {}),
    ...(previous.previewHash || next.previewHash
      ? { previewHash: previous.previewHash ?? next.previewHash }
      : {}),
    ...(previous.completionConfirmedAt || next.completionConfirmedAt
      ? { completionConfirmedAt: previous.completionConfirmedAt ?? next.completionConfirmedAt }
      : {}),
  };
}
export async function persistNetworkSettingsOperationReceipt(
  input: NetworkSettingsOperationReceipt,
): Promise<void> {
  const incoming = receiptSchema.parse(structuredClone(input));
  let value = incoming;
  const previous = queues.get(value.userId) ?? Promise.resolve();
  const work = previous
    .catch(() => undefined)
    .then(async () => {
      const current = listNetworkSettingsOperationReceipts(value.userId);
      value = mergeNetworkSettingsReceipt(
        current.find((row) => row.operationId === value.operationId),
        incoming,
      );
      const values = pruneCompletedReceipts(
        [value, ...current.filter((r) => r.operationId !== value.operationId)],
        value.operationId,
      );
      if (
        values.length > RECEIPT_LIMIT &&
        !current.some((row) => row.operationId === value.operationId)
      )
        throw new Error(
          'Слишком много сохранённых операций. Откройте результаты прежних операций.',
        );
      const serialized = JSON.stringify(values);
      writeLocalMirrorItem(key(value.userId), serialized);
      const localVerified = readLocalMirrorItem(key(value.userId)) === serialized;
      let nativeVerified = false;
      if (isNativeDeviceStorageAvailable()) {
        // FLAG: A native receipt may only reference an equally durable exact scope.
        const scopeKey = networkSettingsScopeStorageKey(value.userId, value.scopeId);
        const scope = readLocalMirrorItem(scopeKey);
        if (!scope) throw new Error('Не найден сохранённый выбор сообществ.');
        await writeNativeStorageItem(scopeKey, scope);
        await writeNativeStorageItem(key(value.userId), serialized);
        const [savedScope, savedReceipt] = await Promise.all([
          readNativeStorageItemState(scopeKey),
          readNativeStorageItemState(key(value.userId)),
        ]);
        nativeVerified =
          savedScope.status === 'found' &&
          savedScope.value === scope &&
          savedReceipt.status === 'found' &&
          savedReceipt.value === serialized;
        if (!nativeVerified)
          throw new Error(
            'Не удалось надёжно сохранить операцию на устройстве. Применение не запущено.',
          );
      }
      if (!localVerified && !nativeVerified)
        throw new Error('Не удалось сохранить операцию. Применение не запущено.');
    });
  queues.set(value.userId, work);
  try {
    await work;
  } finally {
    if (queues.get(value.userId) === work) queues.delete(value.userId);
  }
}
export async function removeNetworkSettingsOperationReceipt(
  userId: string,
  operationId: string,
): Promise<void> {
  const previous = queues.get(userId) ?? Promise.resolve();
  const work = previous
    .catch(() => undefined)
    .then(async () => {
      const list = listNetworkSettingsOperationReceipts(userId);
      const receipt = list.find((r) => r.operationId === operationId);
      if (
        receipt &&
        receipt.launchState !== 'unconfirmed' &&
        !['COMPLETE', 'PARTIAL', 'FAILED'].includes(receipt.lastKnownStatus ?? '')
      )
        return;
      const serialized = JSON.stringify(list.filter((r) => r.operationId !== operationId));
      writeLocalMirrorItem(key(userId), serialized);
      await writeNativeStorageItem(key(userId), serialized);
    });
  queues.set(userId, work);
  try {
    await work;
  } finally {
    if (queues.get(userId) === work) queues.delete(userId);
  }
}
