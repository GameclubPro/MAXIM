import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
} from '../prisma/prisma-client';
import {
  ModerationDeleteIntentAccessWakeService,
  type CommittedBotDeleteAccessProbe,
  type PreviousBotDeleteAccess,
} from './moderation-delete-intent-access-wake.service';

const checkedAt = new Date('2026-08-20T12:00:00.000Z');

function previousAccess(
  overrides: Partial<Exclude<PreviousBotDeleteAccess, null>> = {},
): Exclude<PreviousBotDeleteAccess, null> {
  return {
    status: ChatBotMembershipStatus.ACTIVE,
    botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
    botAccessCheckedAt: new Date('2026-08-20T11:59:00.000Z'),
    botAccessExpiresAt: new Date('2026-08-20T12:14:00.000Z'),
    permissionsSnapshot: {
      checkedAt: '2026-08-20T11:59:00.000Z',
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
    },
    ...overrides,
  };
}

function probe(
  overrides: Partial<CommittedBotDeleteAccessProbe> = {},
): CommittedBotDeleteAccessProbe {
  return {
    chatId: 'chat-1',
    botId: 'bot-1',
    entityType: ChatEntityType.CHAT,
    source: 'admin_roster_sync',
    checkedAt,
    access: {
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    },
    previousAccess: null,
    ...overrides,
  };
}

describe('ModerationDeleteIntentAccessWakeService', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-20T12:00:01.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('recognizes only an edge from absent, stale, or incapable access to delete-capable access', () => {
    const service = new ModerationDeleteIntentAccessWakeService({} as never);

    expect(service.shouldWake(probe())).toBe(true);
    expect(
      service.shouldWake(
        probe({
          previousAccess: previousAccess({
            botAccessState: ChatBotAccessState.STALE,
          }),
        }),
      ),
    ).toBe(true);
    expect(
      service.shouldWake(
        probe({
          previousAccess: previousAccess({
            permissionsSnapshot: {
              checkedAt: '2026-08-20T11:59:00.000Z',
              isAdmin: true,
              isOwner: false,
              permissions: [],
            },
          }),
        }),
      ),
    ).toBe(true);
    expect(service.shouldWake(probe({ previousAccess: previousAccess() }))).toBe(false);
  });

  it('requires write for chats and delete/delete_message for channels', () => {
    const service = new ModerationDeleteIntentAccessWakeService({} as never);

    expect(service.shouldWake(probe())).toBe(true);
    expect(
      service.shouldWake(
        probe({
          access: { isAdmin: true, isOwner: false, permissions: ['delete_message'] },
        }),
      ),
    ).toBe(false);
    expect(
      service.shouldWake(
        probe({
          entityType: ChatEntityType.CHANNEL,
          access: { isAdmin: true, isOwner: false, permissions: ['write'] },
        }),
      ),
    ).toBe(false);
    expect(
      service.shouldWake(
        probe({
          entityType: ChatEntityType.CHANNEL,
          access: { isAdmin: true, isOwner: false, permissions: ['delete_message'] },
        }),
      ),
    ).toBe(true);
  });

  it('does not self-wake from delete-intent probes or denied access evidence', () => {
    const service = new ModerationDeleteIntentAccessWakeService({} as never);

    expect(service.shouldWake(probe({ source: 'moderation_delete_intent_probe' }))).toBe(false);
    expect(service.shouldWake(probe({ source: 'moderation_delete_intent_probe_denied' }))).toBe(
      false,
    );
    expect(service.shouldWake(probe({ access: null }))).toBe(false);
  });

  it('wakes a bounded origin-aware batch while preserving lifecycle and mutation evidence', async () => {
    const executeRaw = jest.fn().mockResolvedValue(100);
    const service = new ModerationDeleteIntentAccessWakeService({
      $executeRaw: executeRaw,
    } as never);

    await expect(service.wakeAfterCommittedProbe(probe())).resolves.toBe(100);

    const query = executeRaw.mock.calls[0]?.[0] as
      | { strings?: readonly string[]; values?: readonly unknown[] }
      | undefined;
    const sql = query?.strings?.join('?') ?? '';
    expect(sql).toContain("'WAITING_CAPABILITY' AS \"ModerationDeleteIntentStatus\"");
    expect(sql).toContain("'IN_PROGRESS' AS \"ModerationDeleteIntentStatus\"");
    expect(sql).toContain('intent."lease_token" IS NOT NULL');
    expect(sql).toContain('intent."lease_expires_at" > CURRENT_TIMESTAMP');
    expect(sql).toContain('intent."routing_policy" <> \'origin_only\'');
    expect(sql).toContain('intent."origin_bot_id" = ?');
    expect(sql).toContain('intent."entity_type" = CAST(? AS "ChatEntityType")');
    expect(sql).toContain('membership."bot_access_checked_at" = ?');
    expect(sql).toContain('membership."bot_access_source" = ?');
    expect(sql).toContain('membership."permissions_hash" = ?');
    expect(sql).toContain('intent."remote_delete_succeeded_at" IS NULL');
    expect(sql).toContain('intent."remote_delete_succeeded_bot_id" IS NULL');
    expect(sql).toContain('intent."delete_dispatch_started_at" IS NULL');
    expect(sql).toContain('intent."delete_dispatch_started_bot_id" IS NULL');
    expect(sql).toContain('intent."last_attempt_at" < ?');
    expect(sql).toContain('LIMIT ?');
    expect(sql).toContain('FOR UPDATE OF intent');
    expect(sql).not.toContain('SKIP LOCKED');
    expect(sql).toContain('"next_attempt_at" = CASE');
    expect(sql).toContain('THEN GREATEST(intent."next_attempt_at", ?)');
    expect(sql).toContain('ELSE CURRENT_TIMESTAMP');
    expect(sql).not.toContain('SET\n        "status"');
    expect(sql).not.toContain('"attempt_count" =');
    expect(sql).not.toContain('SET\n        "retry_until_at"');
    expect(sql).not.toContain('SET\n        "delete_dispatch_started_at"');
    expect(query?.values).toContain(100);
  });

  it('leaves the database untouched when access was already freshly delete-capable', async () => {
    const executeRaw = jest.fn();
    const service = new ModerationDeleteIntentAccessWakeService({
      $executeRaw: executeRaw,
    } as never);

    await expect(
      service.wakeAfterCommittedProbe(probe({ previousAccess: previousAccess() })),
    ).resolves.toBe(0);
    expect(executeRaw).not.toHaveBeenCalled();
  });
});
