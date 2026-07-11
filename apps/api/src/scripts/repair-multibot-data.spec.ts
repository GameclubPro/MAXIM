import {
  ChatBotAccessState,
  ChatBotMembershipRole,
  ChatBotMembershipStatus,
  ChatEntityType,
} from '../prisma/prisma-client';
import {
  parseMultiBotDataRepairOptions,
  planMultiBotEntityRepair,
  type MultiBotRepairEntity,
  type MultiBotRepairMembership,
  type MultiBotRepairRuntimeBot,
} from './repair-multibot-data';

const runtimeBots: MultiBotRepairRuntimeBot[] = [
  { id: 'bot-1', executable: true, probeable: true },
  { id: 'bot-2', executable: true, probeable: true },
  { id: 'bot-draining', executable: false, probeable: true },
  { id: 'bot-disabled', executable: false, probeable: false },
];

function membership(
  botId: string,
  overrides: Partial<MultiBotRepairMembership> = {},
): MultiBotRepairMembership {
  return {
    botId,
    role: ChatBotMembershipRole.STANDBY,
    status: ChatBotMembershipStatus.ACTIVE,
    botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
    botAccessCheckedAt: new Date(),
    botAccessExpiresAt: new Date(Date.now() + 60_000),
    permissionsSnapshot: {
      checkedAt: new Date().toISOString(),
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
    },
    ...overrides,
  };
}

function entity(overrides: Partial<MultiBotRepairEntity> = {}): MultiBotRepairEntity {
  return {
    id: 'chat-1',
    entityType: ChatEntityType.CHAT,
    primaryBotId: null,
    botId: null,
    memberships: [],
    ...overrides,
  };
}

describe('multi-bot data repair CLI options', () => {
  it('is read-only by default and keeps route/probe limits independent', () => {
    expect(parseMultiBotDataRepairOptions([])).toEqual({
      applyRoutes: false,
      applyNoEligible: false,
      enqueueProbes: false,
      json: false,
      help: false,
      routeLimit: 100,
      noEligibleLimit: 100,
      probeLimit: 100,
      pageSize: 500,
      sampleLimit: 50,
      enqueueConcurrency: 4,
    });

    expect(
      parseMultiBotDataRepairOptions([
        '--apply-routes',
        '--route-limit',
        '7',
        '--apply-no-eligible',
        '--no-eligible-limit',
        '5',
        '--enqueue-probes',
        '--probe-limit',
        '13',
        '--json',
      ]),
    ).toEqual(
      expect.objectContaining({
        applyRoutes: true,
        applyNoEligible: true,
        enqueueProbes: true,
        routeLimit: 7,
        noEligibleLimit: 5,
        probeLimit: 13,
        json: true,
      }),
    );
  });

  it('rejects unsafe or ambiguous limits and option typos', () => {
    expect(() => parseMultiBotDataRepairOptions(['--route-limit', '0'])).toThrow(
      '--route-limit must be a positive integer',
    );
    expect(() => parseMultiBotDataRepairOptions(['--page-size', '1001'])).toThrow(
      '--page-size must be at most 1000',
    );
    expect(() => parseMultiBotDataRepairOptions(['--enqueue-concurrency', '17'])).toThrow(
      '--enqueue-concurrency must be at most 16',
    );
    expect(() => parseMultiBotDataRepairOptions(['--apply-route'])).toThrow(
      'Unknown option: --apply-route',
    );
  });
});

describe('multi-bot data repair planner', () => {
  it('leaves an executable active primary unchanged', () => {
    const plan = planMultiBotEntityRepair(
      entity({
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        memberships: [membership('bot-1', { role: ChatBotMembershipRole.PRIMARY })],
      }),
      runtimeBots,
    );

    expect(plan).toEqual(
      expect.objectContaining({
        primaryIssue: null,
        proposedPrimaryBotId: null,
        noEligibleBot: false,
        eligibleBotIds: ['bot-1'],
      }),
    );
  });

  it('repairs a missing primary only from an existing active executable membership', () => {
    const plan = planMultiBotEntityRepair(
      entity({
        memberships: [
          membership('bot-1'),
          membership('bot-2', { role: ChatBotMembershipRole.PRIMARY }),
        ],
      }),
      runtimeBots,
    );

    expect(plan.primaryIssue).toBe('missing_primary');
    expect(plan.eligibleBotIds).toEqual(['bot-1', 'bot-2']);
    expect(plan.proposedPrimaryBotId).toBe('bot-2');
    expect(plan.noEligibleBot).toBe(false);
  });

  it('prefers the eligible legacy mirror when no active membership is marked primary', () => {
    const plan = planMultiBotEntityRepair(
      entity({
        botId: 'bot-2',
        memberships: [membership('bot-1'), membership('bot-2')],
      }),
      runtimeBots,
    );

    expect(plan.proposedPrimaryBotId).toBe('bot-2');
  });

  it('never proposes a removed membership or an unknown historical bot', () => {
    const plan = planMultiBotEntityRepair(
      entity({
        primaryBotId: 'historical-bot-7',
        botId: 'historical-bot-7',
        memberships: [
          membership('historical-bot-7'),
          membership('bot-1', { status: ChatBotMembershipStatus.REMOVED }),
        ],
      }),
      runtimeBots,
    );

    expect(plan.primaryIssue).toBe('unknown_runtime_bot');
    expect(plan.eligibleBotIds).toEqual([]);
    expect(plan.proposedPrimaryBotId).toBeNull();
    expect(plan.noEligibleBot).toBe(true);
  });

  it('queues verification instead of promoting or closing an UNKNOWN active candidate', () => {
    const plan = planMultiBotEntityRepair(
      entity({
        memberships: [
          membership('bot-1', {
            botAccessState: ChatBotAccessState.UNKNOWN,
            botAccessCheckedAt: null,
            botAccessExpiresAt: null,
            permissionsSnapshot: null,
          }),
        ],
      }),
      runtimeBots,
    );

    expect(plan.proposedPrimaryBotId).toBeNull();
    expect(plan.noEligibleBot).toBe(false);
    expect(plan.verificationNeededBotIds).toEqual(['bot-1']);
  });

  it('fails over from an access-denied primary to an eligible survivor and requests one probe', () => {
    const plan = planMultiBotEntityRepair(
      entity({
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        memberships: [
          membership('bot-1', {
            role: ChatBotMembershipRole.PRIMARY,
            botAccessState: ChatBotAccessState.DENIED,
          }),
          membership('bot-2'),
        ],
      }),
      runtimeBots,
    );

    expect(plan.primaryIssue).toBe('membership_access_denied');
    expect(plan.eligibleBotIds).toEqual(['bot-2']);
    expect(plan.proposedPrimaryBotId).toBe('bot-2');
    expect(plan.accessContradictions).toEqual([
      {
        botId: 'bot-1',
        reasons: ['bot_access_denied'],
        knownRuntimeBot: true,
        probeEligible: true,
      },
    ]);
  });

  it('treats an explicit access-loss snapshot as ineligible without changing membership status', () => {
    const input = entity({
      primaryBotId: 'bot-1',
      memberships: [
        membership('bot-1', {
          role: ChatBotMembershipRole.PRIMARY,
          botAccessState: ChatBotAccessState.LOST,
          permissionsSnapshot: { accessLostAt: '2026-07-10T10:00:00.000Z' },
        }),
      ],
    });
    const plan = planMultiBotEntityRepair(input, runtimeBots);

    expect(plan.primaryIssue).toBe('membership_access_denied');
    expect(plan.noEligibleBot).toBe(true);
    expect(plan.accessContradictions[0]).toEqual(
      expect.objectContaining({
        botId: 'bot-1',
        reasons: ['bot_access_lost', 'permissions_snapshot_denied'],
        probeEligible: true,
      }),
    );
    expect(input.memberships[0]?.status).toBe(ChatBotMembershipStatus.ACTIVE);
  });

  it('reports active contradictions for unknown bots but never marks them probeable', () => {
    const plan = planMultiBotEntityRepair(
      entity({
        memberships: [
          membership('historical-bot-7', {
            botAccessState: ChatBotAccessState.DENIED,
          }),
        ],
      }),
      runtimeBots,
    );

    expect(plan.accessContradictions).toEqual([
      {
        botId: 'historical-bot-7',
        reasons: ['bot_access_denied'],
        knownRuntimeBot: false,
        probeEligible: false,
      },
    ]);
  });

  it('can probe a draining bot but cannot select it for execution', () => {
    const plan = planMultiBotEntityRepair(
      entity({
        primaryBotId: 'bot-draining',
        memberships: [
          membership('bot-draining', {
            botAccessState: ChatBotAccessState.DENIED,
          }),
        ],
      }),
      runtimeBots,
    );

    expect(plan.primaryIssue).toBe('non_executable_runtime_bot');
    expect(plan.eligibleBotIds).toEqual([]);
    expect(plan.accessContradictions[0]).toEqual(expect.objectContaining({ probeEligible: true }));
  });

  it('ignores access-loss snapshots on removed rows when scheduling probes', () => {
    const plan = planMultiBotEntityRepair(
      entity({
        memberships: [
          membership('bot-1', {
            status: ChatBotMembershipStatus.REMOVED,
            botAccessState: ChatBotAccessState.LOST,
            permissionsSnapshot: { accessLostAt: '2026-07-10T10:00:00.000Z' },
          }),
        ],
      }),
      runtimeBots,
    );

    expect(plan.accessContradictions).toEqual([]);
    expect(plan.noEligibleBot).toBe(true);
  });
});
