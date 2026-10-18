import type { Prisma } from '../prisma/prisma-client';

export const MANAGED_BROADCAST_OCCURRENCE_RESULT_SELECT = {
  status: true,
  sentCount: true,
  cycleCount: true,
  nextSendAt: true,
} as const satisfies Prisma.ManagedBroadcastSelect;

export const MANAGED_BROADCAST_FINALIZER_DELIVERY_SELECT = {
  targetChatId: true,
  status: true,
  lastErrorCode: true,
  dispatchBlockerCode: true,
  dispatchBlockedAt: true,
  nextAttemptAt: true,
  sentAt: true,
  remoteMessageId: true,
  remoteMessageVerifiedAt: true,
  remoteMessageVerificationAttemptCount: true,
  remoteMessageVerificationAbsentCount: true,
  remoteMessageVerificationPresentCount: true,
  remoteMessageVerificationAttemptedAt: true,
  remoteMessageVerificationNextAt: true,
  remoteMessageVerificationSource: true,
} as const satisfies Prisma.ManagedBroadcastDeliverySelect;
