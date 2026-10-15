import type { AssignManagedModeratorRequest } from '@maxim/contracts';
import {
  readLocalMirrorItem,
  writeLocalMirrorItem,
  readNativeStorageItem,
  writeNativeStorageItem,
} from './native-storage';

// FLAG: Bound the caller's wait without releasing serialization of an unfinished native
// write. A slow bridge must not let a later write overtake a saved operation.
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ModeratorOperationStorageError()), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const storageRevisions = new Map<string, number>();
const pendingStorageWrites = new Map<string, Promise<void>>();
function serialize(key: string, task: () => Promise<void>): Promise<void> {
  const next = (pendingStorageWrites.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(task);
  pendingStorageWrites.set(key, next);
  void next
    .catch(() => undefined)
    .finally(() => {
      if (pendingStorageWrites.get(key) === next) pendingStorageWrites.delete(key);
    });
  return next;
}
function parse(value: string | null): AssignManagedModeratorRequest | null {
  if (!value) return null;
  try {
    const result: unknown = JSON.parse(value);
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
    const row = result as Record<string, unknown>;
    if (
      Object.keys(row).length !== 3 ||
      typeof row.operationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        row.operationId,
      ) ||
      typeof row.moderatorKey !== 'string' ||
      !/^[a-f0-9]{24}$/u.test(row.moderatorKey) ||
      typeof row.expectedRevision !== 'number' ||
      !Number.isInteger(row.expectedRevision) ||
      row.expectedRevision < 0 ||
      row.expectedRevision > 2_147_483_646
    )
      return null;
    return row as AssignManagedModeratorRequest;
  } catch {
    return null;
  }
}
export function moderatorOperationKey(scope: string, entityType: string, entityId: string): string {
  return `maxim:moderator-operation:v1:${encodeURIComponent(scope)}:${entityType}:${encodeURIComponent(entityId)}`;
}
export async function readModeratorOperation(
  key: string,
): Promise<AssignManagedModeratorRequest | null> {
  const writing = pendingStorageWrites.get(key);
  if (writing) await bounded(writing);
  const local = readLocalMirrorItem(key);
  if (local !== null) return parse(local);
  const revision = storageRevisions.get(key);
  const native = await bounded(readNativeStorageItem(key));
  // Prefer a request saved while the native read was in flight.
  const current = readLocalMirrorItem(key);
  if (current !== null || storageRevisions.get(key) !== revision) return parse(current);
  if (native !== null) writeLocalMirrorItem(key, native);
  return parse(native);
}
export function saveModeratorOperation(
  key: string,
  request: AssignManagedModeratorRequest,
): Promise<void> {
  storageRevisions.set(key, (storageRevisions.get(key) ?? 0) + 1);
  const raw = JSON.stringify(request);
  writeLocalMirrorItem(key, raw);
  return bounded(
    serialize(key, async () => {
      await writeNativeStorageItem(key, raw);
      if (readLocalMirrorItem(key) !== raw && (await readNativeStorageItem(key)) !== raw)
        throw new ModeratorOperationStorageError();
    }),
  );
}
export async function clearModeratorOperation(key: string, operationId: string): Promise<void> {
  await bounded(
    serialize(key, async () => {
      const current = parse(readLocalMirrorItem(key));
      if (current && current.operationId !== operationId) return;
      storageRevisions.set(key, (storageRevisions.get(key) ?? 0) + 1);
      // FLAG: Keep a durable tombstone; a failed native remove must not resurrect the
      // old request after a WebView restart. It parses as no pending operation.
      const cleared = JSON.stringify({ cleared: operationId });
      writeLocalMirrorItem(key, cleared);
      await writeNativeStorageItem(key, cleared);
      if (readLocalMirrorItem(key) !== cleared && (await readNativeStorageItem(key)) !== cleared)
        throw new ModeratorOperationStorageError();
    }),
  );
}

export class ModeratorOperationStorageError extends Error {}

export function createModeratorOperationId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
