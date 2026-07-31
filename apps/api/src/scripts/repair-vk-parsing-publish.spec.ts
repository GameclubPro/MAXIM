import {
  acquireRepairLock,
  applyVkPublishRepairPlan,
  assertFrozenOwnershipSnapshot,
  buildDeterministicRepairPlan,
  canonicalJson,
  classifyRepairCandidate,
  classifyRepairOrphan,
  hashRepairPlan,
  hasFreshRepairAccessSnapshot,
  readVkPublishRepairOptions,
  releaseRepairLock,
  renewRepairLock,
  replaceExactInactivePublishJob,
  startRepairLockHeartbeat,
  type RepairCandidateFacts,
  type RepairLedgerEvidence,
  type RepairQueueEvidence,
} from './repair-vk-parsing-publish';

const CUTOFF = new Date('2026-07-31T10:00:00.000Z');

function createFacts(overrides: Partial<RepairCandidateFacts> = {}): RepairCandidateFacts {
  return {
    postId: 'post-1',
    chatId: 'channel-1',
    sourceId: 'source-1',
    status: 'NEW',
    createdAt: '2026-07-31T08:00:00.000Z',
    updatedAt: '2026-07-31T09:00:00.000Z',
    vkPublishedAt: '2026-07-31T08:00:00.000Z',
    publishedMessageId: null,
    publishedAtMax: null,
    autoPublishedAt: null,
    autoPublishError: null,
    publishQueuedAt: '2026-07-31T08:05:00.000Z',
    publishScheduledAt: '2026-08-02T10:00:00.000Z',
    publishCancelledAt: null,
    publishCancelledByUserId: null,
    publishLockedAt: null,
    publishAttemptCount: 0,
    publishIdempotencyKey: 'ownership-key-1',
    publishReason: 'autopublish',
    lastError: null,
    source: {
      status: 'ACTIVE',
      importEnabled: true,
      autoPublishEnabled: true,
      autoPublishEnabledAt: '2026-07-30T00:00:00.000Z',
      autoPublishPausedAt: null,
      autoPublishPausedReason: null,
      publishIntervalMinutes: 60,
      dailyLimit: 3,
      minPublishIntervalMinutes: 30,
      publishMode: 'QUEUE',
      priority: 'NORMAL',
      quietHoursStart: null,
      quietHoursEnd: null,
      lastAutoPublishedAt: null,
      lastErrorCode: null,
      circuitReasonCode: null,
      updatedAt: '2026-07-31T09:00:00.000Z',
    },
    settings: {
      autoPublishEnabled: true,
      autoPublishEnabledAt: '2026-07-30T00:00:00.000Z',
      autoPublishKillSwitchEnabled: false,
      schedulerTimezone: 'UTC',
      quietHoursStart: null,
      quietHoursEnd: null,
      workHoursStart: '00:00',
      workHoursEnd: '00:00',
      distributeEvenlyEnabled: true,
      roundRobinEnabled: true,
      updatedAt: '2026-07-31T09:00:00.000Z',
    },
    access: {
      routingState: 'READY',
      entityType: 'CHANNEL',
      capableBotIds: ['bot-1'],
      memberships: [
        {
          botId: 'bot-1',
          status: 'ACTIVE',
          accessState: 'CONFIRMED_ADMIN',
          accessCheckedAt: '2026-07-31T09:00:00.000Z',
          accessExpiresAt: '2026-08-01T09:00:00.000Z',
          quarantinedUntil: null,
          permissions: ['write'],
          updatedAt: '2026-07-31T09:00:00.000Z',
        },
      ],
    },
    ...overrides,
  };
}

function createQueueEvidence(overrides: Partial<RepairQueueEvidence> = {}): RepairQueueEvidence {
  return {
    presence: 'missing',
    jobId: 'vk-parsing-publish__post-1__ownership-key-1',
    name: null,
    state: 'missing',
    postId: null,
    chatId: null,
    reason: null,
    idempotencyKey: null,
    attemptsMade: 0,
    attemptsStarted: 0,
    processedOn: null,
    finishedOn: null,
    dueAt: null,
    ...overrides,
  };
}

function createLedgerEvidence(overrides: Partial<RepairLedgerEvidence> = {}): RepairLedgerEvidence {
  return {
    presence: 'missing',
    jobId: 'vk-parsing:publish:post-1:ownership-key-1',
    actionType: null,
    chatId: null,
    status: null,
    ambiguous: false,
    terminal: false,
    attemptCount: 0,
    firstAttemptAt: null,
    lastAttemptAt: null,
    dispatchTokenPresent: false,
    dispatchStartedAt: null,
    dispatchBotId: null,
    remoteMessageIdPresent: false,
    updatedAt: null,
    ...overrides,
  };
}

function createRepairPostRow(facts: RepairCandidateFacts): Record<string, unknown> {
  const toDate = (value: string | null): Date | null => (value ? new Date(value) : null);
  return {
    id: facts.postId,
    sourceId: facts.sourceId,
    chatId: facts.chatId,
    status: facts.status,
    createdAt: new Date(facts.createdAt),
    updatedAt: new Date(facts.updatedAt),
    vkPublishedAt: toDate(facts.vkPublishedAt),
    publishedMessageId: facts.publishedMessageId,
    publishedAtMax: toDate(facts.publishedAtMax),
    autoPublishedAt: toDate(facts.autoPublishedAt),
    autoPublishError: facts.autoPublishError,
    publishQueuedAt: toDate(facts.publishQueuedAt),
    publishScheduledAt: toDate(facts.publishScheduledAt),
    publishCancelledAt: toDate(facts.publishCancelledAt),
    publishCancelledByUserId: facts.publishCancelledByUserId,
    publishLockedAt: toDate(facts.publishLockedAt),
    publishAttemptCount: facts.publishAttemptCount,
    publishIdempotencyKey: facts.publishIdempotencyKey,
    publishReason: facts.publishReason,
    lastError: facts.lastError,
    source: {
      id: facts.sourceId,
      ...facts.source,
      autoPublishEnabledAt: toDate(facts.source.autoPublishEnabledAt),
      autoPublishPausedAt: toDate(facts.source.autoPublishPausedAt),
      lastAutoPublishedAt: toDate(facts.source.lastAutoPublishedAt),
      updatedAt: new Date(facts.source.updatedAt),
    },
    chat: {
      entityType: facts.access.entityType,
      routingState: facts.access.routingState,
      updatedAt: new Date(facts.updatedAt),
      vkParsingSettings: facts.settings
        ? {
            ...facts.settings,
            autoPublishEnabledAt: toDate(facts.settings.autoPublishEnabledAt),
            updatedAt: new Date(facts.settings.updatedAt),
          }
        : null,
      botMemberships: facts.access.memberships.map((membership) => ({
        botId: membership.botId,
        status: membership.status,
        botAccessState: membership.accessState,
        botAccessCheckedAt: toDate(membership.accessCheckedAt),
        botAccessExpiresAt: toDate(membership.accessExpiresAt),
        permissionsSnapshot: {
          checkedAt: membership.accessCheckedAt,
          isAdmin: membership.accessState === 'CONFIRMED_ADMIN',
          isOwner: membership.accessState === 'CONFIRMED_OWNER',
          permissions: membership.permissions,
        },
        sendRouteQuarantinedUntil: toDate(membership.quarantinedUntil),
        updatedAt: new Date(membership.updatedAt),
      })),
    },
  };
}

describe('VK parsing publish repair CLI', () => {
  it('defaults to a bounded dry-run and requires an explicit frozen apply plan', () => {
    expect(readVkPublishRepairOptions([], CUTOFF)).toEqual({
      apply: false,
      json: false,
      cutoff: CUTOFF,
      cutoffExplicit: false,
      startAt: new Date('2026-07-31T10:05:00.000Z'),
      startAtExplicit: false,
      chatIds: [],
      limit: 100,
      limitExplicit: false,
      batchSize: 25,
      confirmPlanHash: null,
    });

    const hash = 'a'.repeat(64);
    expect(
      readVkPublishRepairOptions(
        [
          '--apply',
          '--cutoff',
          CUTOFF.toISOString(),
          '--start-at',
          '2026-08-01T10:30:00.000Z',
          '--chat-id',
          'channel-2,channel-1',
          '--chat-id',
          'channel-1',
          '--limit',
          '40',
          '--batch-size',
          '10',
          '--confirm-plan-hash',
          hash,
          '--json',
        ],
        CUTOFF,
      ),
    ).toEqual({
      apply: true,
      json: true,
      cutoff: CUTOFF,
      cutoffExplicit: true,
      startAt: new Date('2026-08-01T10:30:00.000Z'),
      startAtExplicit: true,
      chatIds: ['channel-1', 'channel-2'],
      limit: 40,
      limitExplicit: true,
      batchSize: 10,
      confirmPlanHash: hash,
    });

    expect(() => readVkPublishRepairOptions(['--apply'])).toThrow(
      '--apply requires an explicit --cutoff',
    );
    expect(() => readVkPublishRepairOptions(['--apply', '--cutoff', CUTOFF.toISOString()])).toThrow(
      '--apply requires an explicit --start-at',
    );
    expect(() =>
      readVkPublishRepairOptions([
        '--apply',
        '--cutoff',
        CUTOFF.toISOString(),
        '--start-at',
        CUTOFF.toISOString(),
      ]),
    ).toThrow('--apply requires an explicit --limit');
    expect(() =>
      readVkPublishRepairOptions([
        '--apply',
        '--cutoff',
        CUTOFF.toISOString(),
        '--start-at',
        CUTOFF.toISOString(),
        '--limit',
        '40',
      ]),
    ).toThrow('--apply requires --confirm-plan-hash');
    expect(() => readVkPublishRepairOptions(['--limit', '501'])).toThrow(
      '--limit must be an integer between 1 and 500',
    );
    const completeApplyArgs = [
      '--apply',
      '--cutoff',
      CUTOFF.toISOString(),
      '--start-at',
      '2026-08-01T10:00:00.000Z',
      '--limit',
      '40',
      '--confirm-plan-hash',
      hash,
    ];
    const tooEarlyApplyArgs = [...completeApplyArgs];
    tooEarlyApplyArgs[4] = '2026-08-01T09:59:59.999Z';
    expect(() => readVkPublishRepairOptions(tooEarlyApplyArgs, CUTOFF)).toThrow(
      '--apply requires --start-at at least 24 hours after --cutoff',
    );
    expect(() =>
      readVkPublishRepairOptions(completeApplyArgs, new Date('2026-07-31T10:30:00.001Z')),
    ).toThrow('--apply requires a cutoff no older than 30 minutes');
  });

  it('hashes plans canonically and changes the digest when evidence changes', () => {
    const first = { z: 2, nested: { b: true, a: 'value' }, list: [3, 1] };
    const reordered = { list: [3, 1], nested: { a: 'value', b: true }, z: 2 };

    expect(canonicalJson(first)).toBe(canonicalJson(reordered));
    expect(hashRepairPlan(first)).toBe(hashRepairPlan(reordered));
    expect(hashRepairPlan(first)).not.toBe(hashRepairPlan({ ...first, z: 3 }));
    expect(hashRepairPlan(first)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    ['manual ownership', createFacts({ publishReason: 'manual-schedule' }), 'manual_ownership'],
    ['cancelled ownership', createFacts({ publishCancelledAt: CUTOFF.toISOString() }), 'cancelled'],
    ['DB lock', createFacts({ publishLockedAt: CUTOFF.toISOString() }), 'ownership_locked'],
    ['DB attempt', createFacts({ publishAttemptCount: 1 }), 'attempted_send'],
    [
      'ambiguous DB error',
      createFacts({ lastError: '[max.send_ambiguous] timeout' }),
      'ambiguous_send',
    ],
    [
      'access loss',
      createFacts({
        source: {
          ...createFacts().source,
          lastErrorCode: 'max.access_lost',
        },
      }),
      'access_loss',
    ],
    [
      'unproven access',
      createFacts({ access: { ...createFacts().access, capableBotIds: [] } }),
      'access_unproven',
    ],
  ])('excludes %s before queue mutation', (_label, facts, expected) => {
    expect(classifyRepairCandidate(facts, createQueueEvidence(), createLedgerEvidence())).toBe(
      expected,
    );
  });

  it('excludes active, attempted, malformed, and ambiguous execution evidence', () => {
    const facts = createFacts();
    const exactQueue = createQueueEvidence({
      presence: 'present',
      name: 'publish-vk-post',
      state: 'delayed',
      postId: facts.postId,
      chatId: facts.chatId,
      reason: 'autopublish',
      idempotencyKey: facts.publishIdempotencyKey,
      dueAt: facts.publishScheduledAt,
    });
    expect(
      classifyRepairCandidate(facts, { ...exactQueue, state: 'active' }, createLedgerEvidence()),
    ).toBe('queue_active');
    expect(
      classifyRepairCandidate(facts, { ...exactQueue, attemptsStarted: 1 }, createLedgerEvidence()),
    ).toBe('queue_attempted');
    expect(
      classifyRepairCandidate(
        facts,
        { ...exactQueue, idempotencyKey: 'other-key' },
        createLedgerEvidence(),
      ),
    ).toBe('queue_invalid');
    expect(
      classifyRepairCandidate(
        facts,
        exactQueue,
        createLedgerEvidence({
          presence: 'present',
          actionType: 'SEND_MESSAGE',
          chatId: facts.chatId,
          status: 'AMBIGUOUS',
          ambiguous: true,
        }),
      ),
    ).toBe('ledger_ambiguous');
    expect(
      classifyRepairCandidate(
        facts,
        exactQueue,
        createLedgerEvidence({
          presence: 'present',
          actionType: 'SEND_MESSAGE',
          chatId: facts.chatId,
          status: 'IN_PROGRESS',
        }),
      ),
    ).toBe('ledger_active');
  });

  it('accepts only an exact unattempted job and a pristine ENQUEUED ledger', () => {
    const facts = createFacts();
    expect(
      classifyRepairCandidate(
        facts,
        createQueueEvidence({
          presence: 'present',
          name: 'publish-vk-post',
          state: 'delayed',
          postId: facts.postId,
          chatId: facts.chatId,
          reason: 'autopublish',
          idempotencyKey: facts.publishIdempotencyKey,
          dueAt: facts.publishScheduledAt,
        }),
        createLedgerEvidence({
          presence: 'present',
          actionType: 'SEND_MESSAGE',
          chatId: facts.chatId,
          status: 'ENQUEUED',
          updatedAt: '2026-07-31T09:00:00.000Z',
        }),
      ),
    ).toBeNull();
  });

  it('does not let cancelled or invalid ownership hide unsafe live queue evidence', () => {
    const facts = createFacts();
    const exactQueue = createQueueEvidence({
      presence: 'present',
      name: 'publish-vk-post',
      state: 'delayed',
      postId: facts.postId,
      chatId: facts.chatId,
      reason: 'autopublish',
      idempotencyKey: facts.publishIdempotencyKey,
      dueAt: facts.publishScheduledAt,
    });

    expect(
      classifyRepairCandidate(
        { ...facts, publishCancelledAt: CUTOFF.toISOString() },
        { ...exactQueue, state: 'active' },
        createLedgerEvidence(),
      ),
    ).toBe('queue_active');
    expect(
      classifyRepairCandidate(
        { ...facts, status: 'PUBLISHED' },
        { ...exactQueue, idempotencyKey: 'different-key' },
        createLedgerEvidence(),
      ),
    ).toBe('queue_invalid');
    expect(
      classifyRepairCandidate(
        { ...facts, publishCancelledAt: CUTOFF.toISOString() },
        exactQueue,
        createLedgerEvidence(),
      ),
    ).toBe('cancelled');
  });

  it('builds stable bounded slots per chat and source while preserving ownership keys', () => {
    const first = createFacts();
    const second = createFacts({
      postId: 'post-2',
      publishIdempotencyKey: 'ownership-key-2',
      updatedAt: '2026-07-31T09:01:00.000Z',
    });
    const parallel = createFacts({
      postId: 'post-3',
      chatId: 'channel-2',
      sourceId: 'source-2',
      publishIdempotencyKey: 'ownership-key-3',
      updatedAt: '2026-07-31T09:02:00.000Z',
    });
    const plan = buildDeterministicRepairPlan(
      CUTOFF,
      40,
      10,
      3,
      [first, second, parallel].map((facts) => ({
        facts,
        queue: createQueueEvidence({
          jobId: `vk-parsing-publish__${facts.postId}__${facts.publishIdempotencyKey}`,
        }),
        ledger: createLedgerEvidence({
          jobId: `vk-parsing:publish:${facts.postId}:${facts.publishIdempotencyKey}`,
        }),
      })),
    );

    expect(plan.entries.map((entry) => [entry.postId, entry.nextScheduledAt])).toEqual([
      ['post-1', '2026-07-31T10:00:00.000Z'],
      ['post-2', '2026-07-31T11:00:00.000Z'],
      ['post-3', '2026-07-31T10:00:00.000Z'],
    ]);
    expect(plan.entries.map((entry) => entry.publishIdempotencyKey)).toEqual([
      'ownership-key-1',
      'ownership-key-2',
      'ownership-key-3',
    ]);
    expect(hashRepairPlan(plan)).toBe(hashRepairPlan({ ...plan }));
  });

  it('honors work hours, daily limits, and the distribute-evenly switch in repair slots', () => {
    const first = createFacts({
      settings: {
        ...createFacts().settings!,
        workHoursStart: '12:00',
        workHoursEnd: '13:00',
        distributeEvenlyEnabled: false,
      },
      source: {
        ...createFacts().source,
        dailyLimit: 1,
        publishIntervalMinutes: 180,
        minPublishIntervalMinutes: 30,
      },
    });
    const second = createFacts({
      ...first,
      postId: 'post-2',
      publishIdempotencyKey: 'ownership-key-2',
      updatedAt: '2026-07-31T09:01:00.000Z',
    });
    const plan = buildDeterministicRepairPlan(
      CUTOFF,
      40,
      10,
      2,
      [first, second].map((facts) => ({
        facts,
        queue: createQueueEvidence({
          jobId: `vk-parsing-publish__${facts.postId}__${facts.publishIdempotencyKey}`,
        }),
        ledger: createLedgerEvidence({
          jobId: `vk-parsing:publish:${facts.postId}:${facts.publishIdempotencyKey}`,
        }),
      })),
    );

    expect(plan.entries.map((entry) => entry.nextScheduledAt)).toEqual([
      '2026-07-31T12:00:00.000Z',
      '2026-08-01T12:00:00.000Z',
    ]);
  });

  it('uses the earliest free slot before a far fixed ownership reservation', () => {
    const manual = createFacts({ publishReason: 'manual-schedule' });
    const automatic = createFacts({
      postId: 'post-2',
      publishIdempotencyKey: 'ownership-key-2',
      publishScheduledAt: null,
      updatedAt: '2026-07-31T09:01:00.000Z',
    });
    const plan = buildDeterministicRepairPlan(
      CUTOFF,
      40,
      10,
      2,
      [manual, automatic].map((facts) => ({
        facts,
        queue:
          facts.postId === manual.postId
            ? createQueueEvidence({
                presence: 'present',
                jobId: `vk-parsing-publish__${facts.postId}__${facts.publishIdempotencyKey}`,
                name: 'publish-vk-post',
                state: 'delayed',
                postId: facts.postId,
                chatId: facts.chatId,
                reason: facts.publishReason,
                idempotencyKey: facts.publishIdempotencyKey,
                dueAt: facts.publishScheduledAt,
              })
            : createQueueEvidence({
                jobId: `vk-parsing-publish__${facts.postId}__${facts.publishIdempotencyKey}`,
              }),
        ledger: createLedgerEvidence({
          jobId: `vk-parsing:publish:${facts.postId}:${facts.publishIdempotencyKey}`,
        }),
      })),
    );

    expect(plan.entries.find((entry) => entry.postId === 'post-1')).toMatchObject({
      action: 'skip',
      skipReason: 'manual_ownership',
    });
    expect(plan.entries.find((entry) => entry.postId === 'post-2')?.nextScheduledAt).toBe(
      '2026-07-31T10:00:00.000Z',
    );
  });

  it('reserves a nearby exact job by queue evidence regardless of its skip classification', () => {
    const unproven = createFacts({
      access: {
        ...createFacts().access,
        routingState: 'UNKNOWN',
        capableBotIds: [],
      },
      publishScheduledAt: '2026-07-31T10:30:00.000Z',
    });
    const automatic = createFacts({
      postId: 'post-2',
      publishIdempotencyKey: 'ownership-key-2',
      publishScheduledAt: null,
      updatedAt: '2026-07-31T09:01:00.000Z',
    });
    const plan = buildDeterministicRepairPlan(
      CUTOFF,
      40,
      10,
      2,
      [unproven, automatic].map((facts) => ({
        facts,
        queue:
          facts.postId === unproven.postId
            ? createQueueEvidence({
                presence: 'present',
                jobId: `vk-parsing-publish__${facts.postId}__${facts.publishIdempotencyKey}`,
                name: 'publish-vk-post',
                state: 'delayed',
                postId: facts.postId,
                chatId: facts.chatId,
                reason: 'autopublish',
                idempotencyKey: facts.publishIdempotencyKey,
                dueAt: facts.publishScheduledAt,
              })
            : createQueueEvidence(),
        ledger: createLedgerEvidence(),
      })),
    );

    expect(plan.entries.find((entry) => entry.postId === 'post-1')).toMatchObject({
      action: 'skip',
      skipReason: 'access_unproven',
    });
    expect(plan.entries.find((entry) => entry.postId === 'post-2')?.nextScheduledAt).toBe(
      '2026-07-31T11:30:00.000Z',
    );
  });

  it('preserves an exact repairable job actual slot until that row is planned', () => {
    const first = createFacts({
      postId: 'post-1',
      sourceId: 'source-1',
      publishIdempotencyKey: 'ownership-key-1',
      publishScheduledAt: null,
      source: { ...createFacts().source, priority: 'HIGH' },
    });
    const exact = createFacts({
      postId: 'post-2',
      sourceId: 'source-2',
      publishIdempotencyKey: 'ownership-key-2',
      publishScheduledAt: CUTOFF.toISOString(),
      source: { ...createFacts().source, priority: 'NORMAL' },
    });
    const plan = buildDeterministicRepairPlan(
      CUTOFF,
      40,
      10,
      2,
      [first, exact].map((facts) => ({
        facts,
        queue:
          facts.postId === exact.postId
            ? createQueueEvidence({
                presence: 'present',
                jobId: `vk-parsing-publish__${facts.postId}__${facts.publishIdempotencyKey}`,
                name: 'publish-vk-post',
                state: 'delayed',
                postId: facts.postId,
                chatId: facts.chatId,
                reason: 'autopublish',
                idempotencyKey: facts.publishIdempotencyKey,
                dueAt: '2026-07-31T10:00:04.000Z',
              })
            : createQueueEvidence({
                jobId: `vk-parsing-publish__${facts.postId}__${facts.publishIdempotencyKey}`,
              }),
        ledger: createLedgerEvidence(),
      })),
    );

    expect(
      plan.entries.map((entry) => [entry.postId, entry.action, entry.nextScheduledAt]),
    ).toEqual([
      ['post-1', 'repair', '2026-07-31T10:30:00.000Z'],
      ['post-2', 'already_correct', '2026-07-31T10:00:00.000Z'],
    ]);
  });

  it('fills an earlier free chat slot when a prior candidate is constrained to later work hours', () => {
    const constrained = createFacts({
      postId: 'post-1',
      sourceId: 'source-1',
      publishIdempotencyKey: 'ownership-key-1',
      source: { ...createFacts().source, priority: 'HIGH' },
      settings: {
        ...createFacts().settings!,
        workHoursStart: '12:00',
        workHoursEnd: '13:00',
      },
    });
    const flexible = createFacts({
      postId: 'post-2',
      sourceId: 'source-2',
      publishIdempotencyKey: 'ownership-key-2',
      source: { ...createFacts().source, priority: 'NORMAL' },
    });
    const plan = buildDeterministicRepairPlan(
      CUTOFF,
      40,
      10,
      2,
      [constrained, flexible].map((facts) => ({
        facts,
        queue: createQueueEvidence({
          jobId: `vk-parsing-publish__${facts.postId}__${facts.publishIdempotencyKey}`,
        }),
        ledger: createLedgerEvidence(),
      })),
    );

    expect(plan.entries.map((entry) => [entry.postId, entry.nextScheduledAt])).toEqual([
      ['post-1', '2026-07-31T12:00:00.000Z'],
      ['post-2', '2026-07-31T10:00:00.000Z'],
    ]);
  });

  it('round-robins sources within one chat while preserving source order', () => {
    const first = createFacts();
    const secondSameSource = createFacts({
      postId: 'post-2',
      publishIdempotencyKey: 'ownership-key-2',
      createdAt: '2026-07-31T08:01:00.000Z',
      vkPublishedAt: '2026-07-31T08:01:00.000Z',
    });
    const otherSource = createFacts({
      postId: 'post-3',
      sourceId: 'source-2',
      publishIdempotencyKey: 'ownership-key-3',
      createdAt: '2026-07-31T08:02:00.000Z',
      vkPublishedAt: '2026-07-31T08:02:00.000Z',
    });
    const plan = buildDeterministicRepairPlan(
      CUTOFF,
      40,
      10,
      3,
      [first, secondSameSource, otherSource].map((facts) => ({
        facts,
        queue: createQueueEvidence({
          jobId: `vk-parsing-publish__${facts.postId}__${facts.publishIdempotencyKey}`,
        }),
        ledger: createLedgerEvidence({
          jobId: `vk-parsing:publish:${facts.postId}:${facts.publishIdempotencyKey}`,
        }),
      })),
    );

    expect(plan.entries.map((entry) => entry.postId)).toEqual(['post-1', 'post-3', 'post-2']);
  });

  it('removes only pristine inactive orphan jobs', () => {
    const queue = createQueueEvidence({
      presence: 'present',
      name: 'publish-vk-post',
      state: 'delayed',
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'ownership-key-1',
    });

    expect(classifyRepairOrphan(queue, createLedgerEvidence())).toBeNull();
    expect(classifyRepairOrphan({ ...queue, state: 'active' }, createLedgerEvidence())).toBe(
      'active',
    );
    expect(classifyRepairOrphan({ ...queue, attemptsStarted: 1 }, createLedgerEvidence())).toBe(
      'attempted',
    );
    expect(
      classifyRepairOrphan(
        queue,
        createLedgerEvidence({
          presence: 'present',
          actionType: 'SEND_MESSAGE',
          chatId: 'channel-1',
          status: 'IN_PROGRESS',
        }),
      ),
    ).toBe('ledger_evidence');
  });

  it('removes only the exact inactive job and recreates it with the same key and bounded timing drift', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    const existing = {
      id: 'vk-parsing-publish__post-1__ownership-key-1',
      name: 'publish-vk-post',
      data: {
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'ownership-key-1',
      },
      timestamp: CUTOFF.getTime(),
      delay: 60_000,
      attemptsMade: 0,
      attemptsStarted: 0,
      processedOn: undefined,
      finishedOn: undefined,
      getState: jest.fn().mockResolvedValue('delayed'),
      remove,
    };
    const added = {
      ...existing,
      timestamp: CUTOFF.getTime() + 4_000,
      delay: 60 * 60_000,
      remove: jest.fn(),
    };
    const queue = {
      getJob: jest.fn().mockResolvedValueOnce(existing).mockResolvedValue(added),
      add: jest.fn().mockResolvedValue({}),
    };

    await replaceExactInactivePublishJob(
      queue as never,
      {
        postId: 'post-1',
        chatId: 'channel-1',
        publishIdempotencyKey: 'ownership-key-1',
        nextScheduledAt: '2026-07-31T11:00:00.000Z',
      },
      CUTOFF,
      CUTOFF.getTime(),
    );

    expect(remove).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'publish-vk-post',
      expect.objectContaining({
        postId: 'post-1',
        idempotencyKey: 'ownership-key-1',
      }),
      expect.objectContaining({
        jobId: 'vk-parsing-publish__post-1__ownership-key-1',
        delay: 60 * 60_000,
      }),
    );
    expect(queue.getJob).toHaveBeenCalledTimes(2);
  });

  it('accepts an exact persisted job after an ambiguous BullMQ add failure', async () => {
    const added = {
      id: 'vk-parsing-publish__post-1__ownership-key-1',
      name: 'publish-vk-post',
      data: {
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'ownership-key-1',
      },
      timestamp: CUTOFF.getTime(),
      delay: 60 * 60_000,
      attemptsMade: 0,
      attemptsStarted: 0,
      processedOn: undefined,
      finishedOn: undefined,
      getState: jest.fn().mockResolvedValue('delayed'),
      remove: jest.fn(),
    };
    const queue = {
      getJob: jest.fn().mockResolvedValueOnce(null).mockResolvedValue(added),
      add: jest.fn().mockRejectedValue(new Error('Redis timeout')),
    };

    await expect(
      replaceExactInactivePublishJob(
        queue as never,
        {
          postId: 'post-1',
          chatId: 'channel-1',
          publishIdempotencyKey: 'ownership-key-1',
          nextScheduledAt: '2026-07-31T11:00:00.000Z',
        },
        CUTOFF,
        CUTOFF.getTime(),
      ),
    ).resolves.toBeUndefined();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('recomputes the BullMQ delay before retrying an ambiguous add', async () => {
    const scheduledAt = new Date(CUTOFF.getTime() + 60 * 60_000);
    const added = {
      id: 'vk-parsing-publish__post-1__ownership-key-1',
      name: 'publish-vk-post',
      data: {
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'ownership-key-1',
      },
      timestamp: CUTOFF.getTime() + 10_000,
      delay: 60 * 60_000 - 10_000,
      attemptsMade: 0,
      attemptsStarted: 0,
      processedOn: undefined,
      finishedOn: undefined,
      getState: jest.fn().mockResolvedValue('delayed'),
      remove: jest.fn(),
    };
    const queue = {
      getJob: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValue(added),
      add: jest.fn().mockRejectedValueOnce(new Error('Redis timeout')).mockResolvedValueOnce({}),
    };
    const readNowMs = jest
      .fn()
      .mockReturnValueOnce(CUTOFF.getTime())
      .mockReturnValueOnce(CUTOFF.getTime() + 10_000);

    await expect(
      replaceExactInactivePublishJob(
        queue as never,
        {
          postId: 'post-1',
          chatId: 'channel-1',
          publishIdempotencyKey: 'ownership-key-1',
          nextScheduledAt: scheduledAt.toISOString(),
        },
        CUTOFF,
        readNowMs,
      ),
    ).resolves.toBeUndefined();

    expect(queue.add).toHaveBeenNthCalledWith(
      1,
      'publish-vk-post',
      expect.any(Object),
      expect.objectContaining({ delay: 60 * 60_000 }),
    );
    expect(queue.add).toHaveBeenNthCalledWith(
      2,
      'publish-vk-post',
      expect.any(Object),
      expect.objectContaining({ delay: 60 * 60_000 - 10_000 }),
    );
  });

  it('refuses to remove an active or mismatched exact-ID job', async () => {
    const createQueue = (state: string, idempotencyKey = 'ownership-key-1') => ({
      getJob: jest.fn().mockResolvedValue({
        id: 'vk-parsing-publish__post-1__ownership-key-1',
        name: 'publish-vk-post',
        data: {
          postId: 'post-1',
          chatId: 'channel-1',
          reason: 'autopublish',
          idempotencyKey,
        },
        timestamp: CUTOFF.getTime(),
        delay: 0,
        attemptsMade: 0,
        attemptsStarted: 0,
        getState: jest.fn().mockResolvedValue(state),
        remove: jest.fn(),
      }),
      add: jest.fn(),
    });
    const entry = {
      postId: 'post-1',
      chatId: 'channel-1',
      publishIdempotencyKey: 'ownership-key-1',
      nextScheduledAt: CUTOFF.toISOString(),
    };

    await expect(
      replaceExactInactivePublishJob(createQueue('active') as never, entry, CUTOFF),
    ).rejects.toThrow('Refusing to remove active job');
    await expect(
      replaceExactInactivePublishJob(
        createQueue('delayed', 'different-key') as never,
        entry,
        CUTOFF,
      ),
    ).rejects.toThrow('Refusing to remove non-exact or attempted job');
  });

  it('requires a current, non-future access check even when expiry is still future', () => {
    const observedAt = new Date('2026-07-31T10:00:00.000Z');
    expect(
      hasFreshRepairAccessSnapshot(
        new Date('2026-07-31T09:00:00.000Z'),
        null,
        new Date('2026-07-31T11:00:00.000Z'),
        observedAt,
      ),
    ).toBe(true);
    expect(
      hasFreshRepairAccessSnapshot(
        new Date('2026-07-31T10:30:00.000Z'),
        null,
        new Date('2026-07-31T11:00:00.000Z'),
        observedAt,
      ),
    ).toBe(false);
    expect(
      hasFreshRepairAccessSnapshot(
        new Date('2026-07-31T09:00:00.000Z'),
        null,
        new Date('2026-07-31T09:59:59.999Z'),
        observedAt,
      ),
    ).toBe(false);
  });

  it('refuses apply when the bounded ownership snapshot is truncated', async () => {
    const document = buildDeterministicRepairPlan(CUTOFF, 1, 1, 1, []);
    await expect(
      applyVkPublishRepairPlan({} as never, {} as never, {} as never, 'token-1', {
        planHash: hashRepairPlan(document),
        document,
        queue: { paused: true, active: 0 },
      }),
    ).rejects.toThrow('Selected ownership snapshot is truncated: 0/1');
  });

  it('refuses apply when invalid ownership still has unreservable live queue evidence', async () => {
    const facts = createFacts({ status: 'PUBLISHED' });
    const document = buildDeterministicRepairPlan(CUTOFF, 1, 1, 1, [
      {
        facts,
        queue: createQueueEvidence({
          presence: 'present',
          name: 'publish-vk-post',
          state: 'waiting-children',
          postId: facts.postId,
          chatId: facts.chatId,
          reason: 'autopublish',
          idempotencyKey: 'different-key',
          dueAt: facts.publishScheduledAt,
        }),
        ledger: createLedgerEvidence(),
      },
    ]);

    await expect(
      applyVkPublishRepairPlan({} as never, {} as never, {} as never, 'token-1', {
        planHash: hashRepairPlan(document),
        document,
        queue: { paused: true, active: 0 },
      }),
    ).rejects.toThrow('Plan contains unreservable live BullMQ evidence for post post-1');
  });

  it('refuses a frozen snapshot when ownership appears after cutoff', async () => {
    const document = buildDeterministicRepairPlan(CUTOFF, 1, 1, 1, [], CUTOFF, [], undefined, 0);
    const count = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    await expect(
      assertFrozenOwnershipSnapshot({ vkParsingPost: { count } } as never, document),
    ).rejects.toThrow('Found 1 VK publish ownership rows after the frozen cutoff');
    expect(count).toHaveBeenCalledTimes(2);
  });

  it('rechecks skipped ownership queue evidence under the lock before the first mutation', async () => {
    const skipped = createFacts({
      access: { ...createFacts().access, capableBotIds: [] },
    });
    const repairable = createFacts({
      postId: 'post-2',
      sourceId: 'source-2',
      publishIdempotencyKey: 'ownership-key-2',
      publishScheduledAt: null,
    });
    const document = buildDeterministicRepairPlan(
      CUTOFF,
      2,
      2,
      2,
      [skipped, repairable].map((facts) => ({
        facts,
        queue: createQueueEvidence({
          jobId: `vk-parsing-publish__${facts.postId}__${facts.publishIdempotencyKey}`,
        }),
        ledger: createLedgerEvidence(),
      })),
    );
    const changedSkippedJob = {
      name: 'publish-vk-post',
      data: {
        postId: skipped.postId,
        chatId: skipped.chatId,
        reason: 'autopublish',
        idempotencyKey: skipped.publishIdempotencyKey,
      },
      timestamp: CUTOFF.getTime(),
      delay: 60 * 60_000,
      attemptsMade: 0,
      attemptsStarted: 0,
      processedOn: undefined,
      finishedOn: undefined,
      getState: jest.fn().mockResolvedValue('delayed'),
    };
    const getJob = jest.fn((jobId: string) =>
      Promise.resolve(jobId.includes(skipped.postId) ? changedSkippedJob : null),
    );
    const count = jest
      .fn()
      .mockImplementation(({ where }) =>
        Promise.resolve(Object.hasOwn(where.publishQueuedAt, 'gt') ? 0 : 2),
      );
    const queue = {
      isPaused: jest.fn().mockResolvedValue(true),
      getJobCounts: jest.fn().mockResolvedValue({ active: 0 }),
      getJob,
    };
    const redis = { eval: jest.fn().mockResolvedValue(1) };

    await expect(
      applyVkPublishRepairPlan(
        { vkParsingPost: { count } } as never,
        queue as never,
        redis as never,
        'token-1',
        {
          planHash: hashRepairPlan(document),
          document,
          queue: { paused: true, active: 0 },
        },
      ),
    ).rejects.toThrow('Frozen BullMQ evidence changed for post post-1');
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(getJob).toHaveBeenCalledTimes(2);
  });

  it('rechecks the frozen pause immediately before each successful apply mutation', async () => {
    jest.useFakeTimers().setSystemTime(CUTOFF);
    try {
      const facts = createFacts({ publishScheduledAt: null });
      const document = buildDeterministicRepairPlan(
        CUTOFF,
        1,
        1,
        1,
        [
          {
            facts,
            queue: createQueueEvidence(),
            ledger: createLedgerEvidence(),
          },
        ],
        new Date('2026-07-31T11:00:00.000Z'),
      );
      const entry = document.entries[0]!;
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const auditCreate = jest.fn().mockResolvedValue({});
      const postFindUnique = jest.fn().mockResolvedValue(createRepairPostRow(facts));
      const ledgerFindUnique = jest.fn().mockResolvedValue(null);
      const count = jest
        .fn()
        .mockImplementation(({ where }) =>
          Promise.resolve(Object.hasOwn(where.publishQueuedAt, 'gt') ? 0 : 1),
        );
      const prisma = {
        vkParsingPost: { findUnique: postFindUnique, count },
        maxActionLedgerEntry: { findUnique: ledgerFindUnique },
        $transaction: jest.fn((callback) =>
          callback({
            vkParsingPost: { updateMany },
            auditLog: { create: auditCreate },
          }),
        ),
      };
      const added = {
        id: createQueueEvidence().jobId,
        name: 'publish-vk-post',
        data: {
          postId: facts.postId,
          chatId: facts.chatId,
          reason: 'autopublish',
          idempotencyKey: facts.publishIdempotencyKey,
        },
        timestamp: Date.parse(entry.nextScheduledAt!),
        delay: 0,
        attemptsMade: 0,
        attemptsStarted: 0,
        processedOn: undefined,
        finishedOn: undefined,
        getState: jest.fn().mockResolvedValue('delayed'),
      };
      const getJob = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValue(added);
      const queue = {
        isPaused: jest.fn().mockResolvedValue(true),
        getJobCounts: jest.fn().mockResolvedValue({ active: 0 }),
        getJob,
        add: jest.fn().mockResolvedValue({}),
      };
      const redis = { eval: jest.fn().mockResolvedValue(1) };

      await expect(
        applyVkPublishRepairPlan(prisma as never, queue as never, redis as never, 'token-1', {
          planHash: hashRepairPlan(document),
          document,
          queue: { paused: true, active: 0 },
        }),
      ).resolves.toEqual({
        repairs: [{ postId: facts.postId, result: 'applied' }],
        orphanJobs: [],
      });

      expect(redis.eval).toHaveBeenCalledTimes(4);
      expect(count).toHaveBeenCalledTimes(8);
      expect(redis.eval.mock.invocationCallOrder[0]).toBeLessThan(
        getJob.mock.invocationCallOrder[0]!,
      );
      expect(getJob.mock.invocationCallOrder[0]).toBeLessThan(
        redis.eval.mock.invocationCallOrder[1]!,
      );
      expect(ledgerFindUnique.mock.invocationCallOrder[0]).toBeLessThan(
        redis.eval.mock.invocationCallOrder[2]!,
      );
      expect(redis.eval.mock.invocationCallOrder[2]).toBeLessThan(
        updateMany.mock.invocationCallOrder[0]!,
      );
      expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        redis.eval.mock.invocationCallOrder[3]!,
      );
      expect(redis.eval.mock.invocationCallOrder[3]).toBeLessThan(
        getJob.mock.invocationCallOrder[2]!,
      );
      expect(getJob).toHaveBeenCalledTimes(4);
      expect(queue.add).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps report-only orphan evidence untouched during apply', async () => {
    const document = buildDeterministicRepairPlan(CUTOFF, 1, 1, 0, []);
    const orphanQueue = createQueueEvidence({
      presence: 'present',
      jobId: 'vk-parsing-publish__orphan-post__orphan-key',
      name: 'publish-vk-post',
      state: 'delayed',
      postId: 'orphan-post',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'orphan-key',
      dueAt: '2026-08-01T10:00:00.000Z',
    });
    document.orphanScan.entries.push({
      jobId: orphanQueue.jobId,
      action: 'report_only',
      skipReason: null,
      evidenceHash: hashRepairPlan(orphanQueue),
      queue: orphanQueue,
      ledger: createLedgerEvidence(),
    });
    const getJob = jest.fn();

    await expect(
      applyVkPublishRepairPlan(
        {} as never,
        { getJob } as never,
        { eval: jest.fn() } as never,
        'token-1',
        {
          planHash: hashRepairPlan(document),
          document,
          queue: { paused: true, active: 0 },
        },
      ),
    ).resolves.toEqual({ repairs: [], orphanJobs: [] });
    expect(getJob).not.toHaveBeenCalled();
  });

  it('reports a lost heartbeat lock to the apply owner', async () => {
    jest.useFakeTimers();
    try {
      const redis = { eval: jest.fn().mockResolvedValue(0) };
      const heartbeat = startRepairLockHeartbeat(redis as never, 'token-1', 10);
      await jest.advanceTimersByTimeAsync(10);
      expect(() => heartbeat.assertHealthy()).toThrow(
        'Lost the distributed VK publish repair lock',
      );
      await heartbeat.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses a token-scoped distributed lock for acquire, renew, and release', async () => {
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
    };

    await expect(acquireRepairLock(redis as never, 'token-1')).resolves.toBe('token-1');
    await expect(renewRepairLock(redis as never, 'token-1')).resolves.toBe(true);
    await expect(releaseRepairLock(redis as never, 'token-1')).resolves.toBeUndefined();

    expect(redis.set).toHaveBeenCalledWith(
      'maxim:repair:vk-parsing-publish:v1',
      'token-1',
      'PX',
      15 * 60_000,
      'NX',
    );
    expect(String(redis.eval.mock.calls[0]?.[0])).toContain('pexpire');
    expect(String(redis.eval.mock.calls[1]?.[0])).toContain('del');
  });
});
