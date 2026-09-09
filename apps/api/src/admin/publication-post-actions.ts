import {
  publicationPostPublishSchema,
  type PublicationPostActions,
} from '@maxim/contracts/publication';
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

export function mapPublicationPostActions(row: ManagedBroadcastDelivery): PublicationPostActions {
  return {
    pinStatus: row.pinStatus ?? 'NONE',
    pinError: row.pinError ?? null,
    deleteStatus: row.deleteStatus ?? 'NONE',
    deleteAt: row.deleteAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    deleteError: row.deleteError ?? null,
  };
}
