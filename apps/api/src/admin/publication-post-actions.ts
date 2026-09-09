import {
  publicationPostPublishSchema,
  type PublicationPostActions,
  type PublicationPostActionCommand,
} from '@maxim/contracts/publication';
import { createHash } from 'node:crypto';
import {
  type ManagedBroadcastDelivery,
  type PublicationContentRevision,
  PublicationPostActionStatus as Status,
} from '../prisma/prisma-client';

export type PublicationPostActionRetryContent = Pick<
  PublicationContentRevision,
  'id' | 'revision' | 'text' | 'textFormat' | 'buttons' | 'postPublish'
>;

export function publicationPostActionsInitialData(value: unknown, at: Date) {
  const policy = publicationPostPublishSchema.parse(value ?? {});
  return {
    postActionsNextAt: policy.pin !== 'none' || policy.deleteAfterMinutes !== null ? at : null,
    pinStatus: policy.pin === 'none' ? Status.NONE : Status.PENDING,
    deleteStatus: policy.deleteAfterMinutes === null ? Status.NONE : Status.PENDING,
  };
}

export function publicationPostActionsRetryData(value: unknown) {
  return {
    ...publicationPostActionsInitialData(value, new Date()),
    postActionsToken: null,
    pinAttemptCount: 0,
    pinError: null,
    deleteAttemptCount: 0,
    deleteAt: null,
    deletedAt: null,
    deleteError: null,
  };
}

export function publicationPostActionsVersion(row: ManagedBroadcastDelivery): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.updatedAt,
        row.postActionsToken,
        row.postActionsNextAt,
        row.pinStatus,
        row.pinAttemptCount,
        row.deleteStatus,
        row.deleteAt,
        row.deletedAt,
        row.deleteAttemptCount,
      ]),
    )
    .digest('hex');
}

export function allowedPublicationPostActions(
  row: ManagedBroadcastDelivery,
  policyValue: unknown,
  nowMs = Date.now(),
): PublicationPostActionCommand[] {
  if (
    row.status !== 'SENT' ||
    !row.remoteMessageId ||
    row.postActionsToken ||
    row.pinStatus === 'RUNNING' ||
    row.deleteStatus === 'RUNNING' ||
    row.deleteStatus === 'DONE' ||
    row.deletedAt
  )
    return [];
  const actions: PublicationPostActionCommand[] = ['reschedule_delete'];
  if (row.deleteStatus === 'PENDING') actions.push('cancel_delete');
  if (row.deleteStatus === 'FAILED' && row.deleteAt) actions.push('retry_delete');
  const policy = publicationPostPublishSchema.safeParse(policyValue ?? {});
  if (
    row.pinStatus === 'FAILED' &&
    policy.success &&
    policy.data.pin !== 'none' &&
    !(row.deleteStatus === 'PENDING' && row.deleteAt && row.deleteAt.getTime() <= nowMs)
  )
    actions.push('retry_pin');
  return actions;
}

export function mapPublicationPostActions(
  row: ManagedBroadcastDelivery,
  policy?: unknown,
): PublicationPostActions {
  return {
    version: publicationPostActionsVersion(row),
    busy: Boolean(
      row.postActionsToken || row.pinStatus === 'RUNNING' || row.deleteStatus === 'RUNNING',
    ),
    allowedActions: allowedPublicationPostActions(row, policy),
    pinStatus: row.pinStatus ?? 'NONE',
    pinError: row.pinError ?? null,
    deleteStatus: row.deleteStatus ?? 'NONE',
    deleteAt: row.deleteStatus === 'SKIPPED' ? null : (row.deleteAt?.toISOString() ?? null),
    deletedAt: row.deletedAt?.toISOString() ?? null,
    deleteError: row.deleteError ?? null,
  };
}
