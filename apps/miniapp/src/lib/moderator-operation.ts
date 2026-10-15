import {
  assignManagedModeratorRequestSchema,
  type AssignManagedModeratorRequest,
} from '@maxim/contracts/managed-entities';
import {
  readLocalMirrorItem,
  writeLocalMirrorItem,
  removeLocalMirrorItem,
  readNativeStorageItem,
  writeNativeStorageItem,
  removeNativeStorageItem,
} from './native-storage';

const storageRevisions = new Map<string, number>();
const pendingStorageWrites = new Map<string, Promise<void>>();
function serialize(key: string, task: () => Promise<void>): Promise<void> {
  const next = (pendingStorageWrites.get(key) ?? Promise.resolve()).then(task);
  pendingStorageWrites.set(key, next);
  void next.finally(() => {
    if (pendingStorageWrites.get(key) === next) pendingStorageWrites.delete(key);
  });
  return next;
}
function parse(value: string | null): AssignManagedModeratorRequest | null {
  if (!value) return null;
  try {
    const result = assignManagedModeratorRequestSchema.safeParse(JSON.parse(value));
    return result.success ? result.data : null;
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
  await pendingStorageWrites.get(key);
  const local = readLocalMirrorItem(key);
  if (local !== null) return parse(local);
  const revision = storageRevisions.get(key);
  const native = await readNativeStorageItem(key);
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
  return serialize(key, () => writeNativeStorageItem(key, raw));
}
export async function clearModeratorOperation(key: string, operationId: string): Promise<void> {
  await serialize(key, async () => {
    const current = parse(readLocalMirrorItem(key));
    if (current && current.operationId !== operationId) return;
    storageRevisions.set(key, (storageRevisions.get(key) ?? 0) + 1);
    removeLocalMirrorItem(key);
    await removeNativeStorageItem(key);
  });
}
