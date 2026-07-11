import { ChatBotAccessState, ChatBotMembershipStatus } from '../prisma/prisma-client';
import {
  resolveStableMaxBotOwnershipBotId,
  resolveWeightedRendezvousOwnerBotId,
  type MaxBotOwnershipCandidate,
} from './max-bot-ownership-assignment.util';

function buildCandidates(count: number): MaxBotOwnershipCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    botId: `bot-${index + 1}`,
    membershipStatus: ChatBotMembershipStatus.ACTIVE,
    lifecycleState: 'active' as const,
    capabilityEligible: true,
    ownershipWeight: 1,
    permissionsSnapshot: {
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
    },
  }));
}

describe('weighted MAX bot ownership assignment', () => {
  it.each([1, 2, 3, 6])('distributes deterministically across %i eligible bot(s)', (botCount) => {
    const candidates = buildCandidates(botCount);
    const reversedCandidates = [...candidates].reverse();
    const entityKeys = Array.from({ length: 6_000 }, (_, index) => `entity-${index}`);
    const assignments = entityKeys.map((entityKey) =>
      resolveWeightedRendezvousOwnerBotId(entityKey, candidates),
    );
    const reversedAssignments = entityKeys.map((entityKey) =>
      resolveWeightedRendezvousOwnerBotId(entityKey, reversedCandidates),
    );

    expect(reversedAssignments).toEqual(assignments);
    const counts = new Map<string, number>();
    for (const botId of assignments) {
      expect(botId).not.toBeNull();
      counts.set(botId!, (counts.get(botId!) ?? 0) + 1);
    }

    const expectedPerBot = entityKeys.length / botCount;
    for (const candidate of candidates) {
      const count = counts.get(candidate.botId) ?? 0;
      expect(count).toBeGreaterThan(expectedPerBot * 0.8);
      expect(count).toBeLessThan(expectedPerBot * 1.2);
    }
  });

  it('honors ownership weights without changing deterministic assignments', () => {
    const candidates = buildCandidates(2);
    candidates[1]!.ownershipWeight = 3;
    const entityKeys = Array.from({ length: 8_000 }, (_, index) => `weighted-${index}`);
    const assignments = entityKeys.map((entityKey) =>
      resolveWeightedRendezvousOwnerBotId(entityKey, candidates),
    );
    const firstBotCount = assignments.filter((botId) => botId === 'bot-1').length;
    const secondBotCount = assignments.filter((botId) => botId === 'bot-2').length;

    expect(secondBotCount / firstBotCount).toBeGreaterThan(2.6);
    expect(secondBotCount / firstBotCount).toBeLessThan(3.4);
    expect(
      entityKeys.map((entityKey) => resolveWeightedRendezvousOwnerBotId(entityKey, candidates)),
    ).toEqual(assignments);
  });

  it('excludes removed, draining, denied, and capability-ineligible candidates', () => {
    const [eligible] = buildCandidates(1);
    const candidates: MaxBotOwnershipCandidate[] = [
      eligible!,
      {
        ...eligible!,
        botId: 'removed-bot',
        membershipStatus: ChatBotMembershipStatus.REMOVED,
      },
      {
        ...eligible!,
        botId: 'draining-bot',
        lifecycleState: 'draining',
      },
      {
        ...eligible!,
        botId: 'denied-bot',
        permissionsSnapshot: {
          isAdmin: false,
          isOwner: false,
          permissions: [],
        },
      },
      {
        ...eligible!,
        botId: 'structured-lost-bot',
        botAccessState: ChatBotAccessState.LOST,
      },
      {
        ...eligible!,
        botId: 'incapable-bot',
        capabilityEligible: false,
      },
    ];

    expect(resolveWeightedRendezvousOwnerBotId('entity-1', candidates)).toBe('bot-1');
  });

  it('keeps an eligible current owner until an explicit rebalance or access loss', () => {
    const candidates = buildCandidates(3);
    const rendezvousOwner = resolveWeightedRendezvousOwnerBotId('stable-entity', candidates);
    const retainedOwner = candidates.find(
      (candidate) => candidate.botId !== rendezvousOwner,
    )!.botId;

    expect(
      resolveStableMaxBotOwnershipBotId('stable-entity', candidates, {
        currentOwnerBotId: retainedOwner,
      }),
    ).toBe(retainedOwner);
    expect(
      resolveStableMaxBotOwnershipBotId('stable-entity', candidates, {
        currentOwnerBotId: retainedOwner,
        rebalance: true,
      }),
    ).toBe(rendezvousOwner);

    const deniedCandidates = candidates.map((candidate) =>
      candidate.botId === retainedOwner
        ? {
            ...candidate,
            permissionsSnapshot: { isAdmin: false, isOwner: false, permissions: [] },
          }
        : candidate,
    );
    expect(
      resolveStableMaxBotOwnershipBotId('stable-entity', deniedCandidates, {
        currentOwnerBotId: retainedOwner,
      }),
    ).toBe(rendezvousOwner);
  });
});
