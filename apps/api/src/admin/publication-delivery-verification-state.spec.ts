import {
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  PublicationOccurrenceStatus,
} from '../prisma/prisma-client';
import { resolvePublicationOccurrenceRollupStatus } from './publication-delivery-verification-state';

const observedAt = new Date('2026-09-04T10:00:00.000Z');
const scheduledAt = new Date('2026-09-04T09:59:00.000Z');

const delivery = (status: ManagedBroadcastDeliveryStatus) => ({
  status,
  remoteMessageId: status === ManagedBroadcastDeliveryStatus.SENT ? 'message-1' : null,
  remoteMessageVerifiedAt: status === ManagedBroadcastDeliveryStatus.SENT ? observedAt : null,
});

describe('publication occurrence rollup status', () => {
  it('rolls a failed envelope with 99 untouched pending deliveries up as failed', () => {
    expect(
      resolvePublicationOccurrenceRollupStatus(
        [
          {
            status: ManagedBroadcastStatus.FAILED,
            deliveries: Array.from({ length: 99 }, () =>
              delivery(ManagedBroadcastDeliveryStatus.PENDING),
            ),
          },
        ],
        scheduledAt,
        observedAt,
      ),
    ).toBe(PublicationOccurrenceStatus.FAILED);
  });

  it('rolls a sent and untouched-pending terminal envelope up as partial', () => {
    expect(
      resolvePublicationOccurrenceRollupStatus(
        [
          {
            status: ManagedBroadcastStatus.PARTIAL,
            deliveries: [
              delivery(ManagedBroadcastDeliveryStatus.SENT),
              delivery(ManagedBroadcastDeliveryStatus.PENDING),
            ],
          },
        ],
        scheduledAt,
        observedAt,
      ),
    ).toBe(PublicationOccurrenceStatus.PARTIAL);
  });

  it('keeps a terminal envelope nonterminal while any delivery is still sending', () => {
    expect(
      resolvePublicationOccurrenceRollupStatus(
        [
          {
            status: ManagedBroadcastStatus.FAILED,
            deliveries: [
              delivery(ManagedBroadcastDeliveryStatus.PENDING),
              delivery(ManagedBroadcastDeliveryStatus.SENDING),
            ],
          },
        ],
        scheduledAt,
        observedAt,
      ),
    ).toBe(PublicationOccurrenceStatus.IN_PROGRESS);
  });

  it('keeps aggregate ambiguity ahead of retryable terminal pending work', () => {
    expect(
      resolvePublicationOccurrenceRollupStatus(
        [
          {
            status: ManagedBroadcastStatus.PARTIAL,
            deliveries: [
              delivery(ManagedBroadcastDeliveryStatus.AMBIGUOUS),
              delivery(ManagedBroadcastDeliveryStatus.PENDING),
            ],
          },
        ],
        scheduledAt,
        observedAt,
      ),
    ).toBe(PublicationOccurrenceStatus.AMBIGUOUS);
  });
});
