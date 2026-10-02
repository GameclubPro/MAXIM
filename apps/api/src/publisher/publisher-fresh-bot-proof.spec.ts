import { buildBotAccessSnapshotPersistence } from '../max/bot-access-snapshot.util';
import { ChatBotMembershipStatus } from '../prisma/prisma-client';
import { readPublisherFreshBotProof } from './publisher-fresh-bot-proof';

describe('Exact Publisher SQL proof reuse', () => {
  const now = new Date('2026-10-02T18:00:00Z');
  const binding = () => ({
    publisherBotId: 'publisher',
    status: ChatBotMembershipStatus.ACTIVE as ChatBotMembershipStatus,
    lifecycleEventAt: null as Date | null,
    lifecycleEventType: null as string | null,
    ...buildBotAccessSnapshotPersistence(
      { isAdmin: true, isOwner: false, permissions: ['write'], permissionsKnown: true },
      { source: 'test', now: new Date(now.getTime() - 60_000) },
    ),
  });
  it('reuses only the exact fresh committed snapshot without changing its timestamp', () => {
    const row = binding();
    expect(readPublisherFreshBotProof(row, 'publisher', now)).toMatchObject({
      isAdmin: true,
      permissions: ['write'],
    });
    expect(row.botAccessCheckedAt.getTime()).toBe(now.getTime() - 60_000);
  });
  it.each([
    'wrong_bot',
    'expired',
    'near_expiry',
    'future_proof',
    'old_proof',
    'removed',
    'new_generation',
    'wrong_snapshot',
    'denied_snapshot',
  ])('requires a new remote probe for %s', (kind) => {
    const row = binding();
    if (kind === 'wrong_bot') row.publisherBotId = 'other';
    if (kind === 'expired') row.botAccessExpiresAt = now;
    if (kind === 'near_expiry') row.botAccessExpiresAt = new Date(now.getTime() + 5_000);
    if (kind === 'future_proof') row.botAccessCheckedAt = new Date(now.getTime() + 1);
    if (kind === 'old_proof') row.botAccessCheckedAt = new Date(now.getTime() - 15 * 60_000);
    if (kind === 'removed') row.status = ChatBotMembershipStatus.REMOVED;
    if (kind === 'new_generation') {
      row.lifecycleEventAt = now;
      row.lifecycleEventType = 'bot_added';
    }
    if (kind === 'wrong_snapshot') row.permissionsSnapshot = { checkedAt: now.toISOString() };
    if (kind === 'denied_snapshot')
      row.permissionsSnapshot = {
        checkedAt: row.botAccessCheckedAt.toISOString(),
        isAdmin: false,
        isOwner: false,
        permissions: [],
      };
    expect(readPublisherFreshBotProof(row, 'publisher', now)).toBeNull();
  });
});
