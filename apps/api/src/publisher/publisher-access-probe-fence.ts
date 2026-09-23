import type { Prisma } from '../prisma/prisma-client';

const PASSIVE_OBSERVATIONS = [
  'message_created',
  'message_edited',
  'message_removed',
  'message_callback',
  'chat_title_changed',
];

export function publisherAccessProbeLifecycleWhere(
  probeStartedAt: Date,
): Prisma.PublisherEntityBindingWhereInput {
  // FLAG: Passive traffic orders webhooks but cannot starve access renewal. Bot-added resets
  // botAccessCheckedAt to its event epoch; callers must also fence that exact access snapshot.
  return {
    OR: [
      { lifecycleEventAt: null },
      { lifecycleEventAt: { lte: probeStartedAt } },
      { lifecycleEventType: { in: PASSIVE_OBSERVATIONS } },
    ],
  };
}

export function publisherAccessProbeLifecycleSuperseded(
  binding: { lifecycleEventAt: Date | null; lifecycleEventType?: string | null },
  probeStartedAt: Date,
): boolean {
  return Boolean(
    binding.lifecycleEventAt &&
    binding.lifecycleEventAt > probeStartedAt &&
    !PASSIVE_OBSERVATIONS.includes(binding.lifecycleEventType ?? ''),
  );
}
