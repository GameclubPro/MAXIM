import { ConfigService } from '@nestjs/config';
import { MaxClientService } from '../max/max-client.service';
import { isMaxExactMessageLookupMissingIdError } from '../max/max-exact-message-lookup.error';
import { fingerprintModerationSettings } from './message-limits-delete-guard.service';
import {
  RequiredSubscriptionExecutionGuardService,
  RequiredSubscriptionExecutionRejectedError,
  RequiredSubscriptionInitialSourceUnavailableError,
} from './required-subscription-execution-guard.service';
import {
  markMaxMemberMutationAttempted,
  markMaxMemberMutationConfirmed,
} from '../max/max-member-error.util';
import { markMaxMessageSendAttempted } from '../max/max-mutation-outcome.util';

async function exactLookupFailure(data: Record<string, unknown>): Promise<unknown> {
  const request = jest.fn().mockResolvedValueOnce({ messages: [] }).mockResolvedValueOnce(data);
  const client: MaxClientService = Object.assign(Object.create(MaxClientService.prototype), {
    normalizeReadRequestOptions: () => ({}),
    executeGlobalRequest: (operation: () => Promise<unknown>) => operation(),
    request,
  });
  try {
    await client.getExactMessageRow('-123', 'm1');
  } catch (error) {
    expect(request.mock.calls.map(([method, path]) => [method, path])).toEqual([
      ['get', '/messages'],
      ['get', '/messages/m1'],
    ]);
    return error;
  }
  throw new Error('Expected the exact MAX lookup to reject the supplied response');
}

function fixture() {
  const settings = {
    requiredSubscriptionEnabled: true,
    requiredSubscriptionChannelIds: ['target-1', 'target-2'],
    requiredSubscriptionWarnEnabled: true,
    requiredSubscriptionMuteEnabled: true,
    requiredSubscriptionBanEnabled: true,
    requiredSubscriptionMuteDurationHours: 1,
    nightModeTimezone: 'UTC',
    chat: { entityType: 'CHAT', admins: [] as unknown[] },
  };
  const at = Date.now();
  const input = {
    chatId: '-123',
    messageId: 'm1',
    subjectUserId: 'user-1',
    botId: 'selected-peer',
    reasons: [
      {
        ruleCode: 'REQUIRED_SUBSCRIPTION_DELETE',
        reasonKey: 'subscription',
        metadata: {
          requiredSubscriptionGuardVersion: 1,
          requiredSubscriptionSourceAtMs: at,
          requiredSubscriptionDeadlineAtMs: at + 300_000,
          requiredSubscriptionPolicySha256: fingerprintModerationSettings(
            settings,
            'REQUIRED_SUBSCRIPTION',
          ),
        },
      },
    ],
  };
  const prisma = { chatSettings: { findUnique: jest.fn(async () => settings) } };
  const max = {
    getChatMemberAccess: jest.fn(async () => ({
      userId: 'user-1',
      isAdmin: false,
      isOwner: false,
    })),
    getExactMessageRow: jest.fn(async () => ({
      sender: { user_id: 'user-1' },
      recipient: { chat_id: '-123', chat_type: 'chat' },
      timestamp: at,
      body: { mid: 'm1', text: 'hello' },
    })),
  };
  const membership = {
    getMembershipResolution: jest.fn(async () => ({ membership: false, fresh: true })),
    getLookupIssue: jest.fn(() => null as unknown),
  };
  const immunity = { consumeForMessage: jest.fn(async () => 'not_granted') };
  const bots = { isKnownBotUserId: jest.fn(() => false) };
  const service = new RequiredSubscriptionExecutionGuardService(
    prisma as never,
    max as never,
    bots as never,
    membership as never,
    immunity as never,
    new ConfigService(),
  );
  return { service, input, settings, max, membership, immunity, prisma, bots };
}

describe('required subscription execution authorization', () => {
  it.each([{}, { message: { body: { text: 'hello' } } }, { body: { mid: 'another-message' } }])(
    'distinguishes genuine initial source GET missing requested ID (%j)',
    async (data) => {
      const s = fixture();
      const error = await exactLookupFailure(data);
      expect(isMaxExactMessageLookupMissingIdError(error)).toBe(true);
      const beforeFinalAuthority = jest.fn();
      s.max.getExactMessageRow.mockRejectedValue(error);
      await expect(
        s.service.authorize({ ...s.input, initialQualification: true, beforeFinalAuthority }),
      ).rejects.toMatchObject({
        constructor: RequiredSubscriptionInitialSourceUnavailableError,
        cause: error,
      });
      expect(s.membership.getMembershipResolution).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      expect(beforeFinalAuthority).not.toHaveBeenCalled();
      await expect(s.service.authorize(s.input)).rejects.toBe(error);
      await expect(s.service.authorize({ ...s.input, initialQualification: false })).rejects.toBe(
        error,
      );
    },
  );

  it.each([{ body: { mid: 'm1' }, recipient: { chat_id: '-456' } }, { body: { mid: 'm1' } }])(
    'preserves other initial source identity failures (%j)',
    async (message) => {
      const s = fixture();
      const error = await exactLookupFailure({ message });
      expect(isMaxExactMessageLookupMissingIdError(error)).toBe(false);
      s.max.getExactMessageRow.mockRejectedValue(error);
      await expect(s.service.authorize({ ...s.input, initialQualification: true })).rejects.toBe(
        error,
      );
      expect(s.membership.getMembershipResolution).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
    },
  );

  it('does not accept copied missing-ID error text, name, properties or prototype as provenance', async () => {
    const genuine = (await exactLookupFailure({})) as Error;
    const errors = [
      new Error(genuine.message),
      Object.assign(new Error(genuine.message), genuine),
      Object.assign(Object.create(Object.getPrototypeOf(genuine)), genuine),
      new Error('wrapped lookup failure', { cause: genuine }),
    ];
    for (const error of errors) {
      const s = fixture();
      expect(isMaxExactMessageLookupMissingIdError(error)).toBe(false);
      s.max.getExactMessageRow.mockRejectedValue(error);
      await expect(s.service.authorize({ ...s.input, initialQualification: true })).rejects.toBe(
        error,
      );
      expect(s.membership.getMembershipResolution).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
    }
  });

  it.each(['member-access', 'target-membership'] as const)(
    'preserves a genuine missing-ID failure from %s during initial qualification',
    async (source) => {
      const s = fixture();
      const error = await exactLookupFailure({});
      if (source === 'member-access') s.max.getChatMemberAccess.mockRejectedValue(error);
      else s.membership.getMembershipResolution.mockRejectedValue(error);
      await expect(s.service.authorize({ ...s.input, initialQualification: true })).rejects.toBe(
        error,
      );
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      if (source === 'member-access') expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['send attempted', markMaxMessageSendAttempted],
    ['member attempted', markMaxMemberMutationAttempted],
    ['member confirmed', markMaxMemberMutationConfirmed],
    [
      'ambiguous status',
      (error: unknown) => Object.assign(error as object, { response: { status: 503 } }),
    ],
    [
      'ambiguous mutation',
      (error: unknown) => Object.assign(error as object, { message: 'ambiguous MAX mutation' }),
    ],
  ] as const)('preserves genuine missing-ID error with %s', async (_label, mark) => {
    const s = fixture();
    const error = mark(await exactLookupFailure({}));
    expect(isMaxExactMessageLookupMissingIdError(error)).toBe(true);
    s.max.getExactMessageRow.mockRejectedValue(error);
    await expect(s.service.authorize({ ...s.input, initialQualification: true })).rejects.toBe(
      error,
    );
    expect(s.membership.getMembershipResolution).not.toHaveBeenCalled();
    expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
  });

  it.each([{ response: { status: 404, data: {} } }, { status: 404 }, { getStatus: () => 404 }])(
    'distinguishes initial source GET 404 without granting authority or consuming immunity (%j)',
    async (error) => {
      const s = fixture();
      const beforeFinalAuthority = jest.fn();
      s.max.getExactMessageRow.mockRejectedValue(error);
      let failure: unknown;
      try {
        await s.service.authorize({ ...s.input, initialQualification: true, beforeFinalAuthority });
      } catch (caught) {
        failure = caught;
      }
      expect(failure).toBeInstanceOf(RequiredSubscriptionInitialSourceUnavailableError);
      expect(failure).not.toBeInstanceOf(RequiredSubscriptionExecutionRejectedError);
      expect((failure as Error).cause).toBe(error);
      expect(s.membership.getMembershipResolution).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      expect(beforeFinalAuthority).not.toHaveBeenCalled();
      await expect(s.service.authorize(s.input)).rejects.toBe(error);
      await expect(s.service.authorize({ ...s.input, initialQualification: false })).rejects.toBe(
        error,
      );
    },
  );

  it.each(['member-access', 'target-membership'] as const)(
    'preserves a %s GET 404 during initial qualification',
    async (source) => {
      const s = fixture();
      const error = { response: { status: 404, data: {} } };
      if (source === 'member-access') s.max.getChatMemberAccess.mockRejectedValue(error);
      else s.membership.getMembershipResolution.mockRejectedValue(error);
      await expect(s.service.authorize({ ...s.input, initialQualification: true })).rejects.toBe(
        error,
      );
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      if (source === 'member-access') expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
    },
  );

  it.each([
    { response: { status: 403, data: {} } },
    { response: { status: 500, data: {} } },
    new Error('source transport unavailable'),
    Object.assign(new Error('ambiguous MAX mutation'), { response: { status: 404, data: {} } }),
    markMaxMessageSendAttempted({ response: { status: 404, data: {} } }),
    markMaxMemberMutationAttempted({ response: { status: 404, data: {} } }),
    markMaxMemberMutationConfirmed({ response: { status: 404, data: {} } }),
  ])(
    'preserves initial non-404 and attempted or ambiguous mutation failures (%j)',
    async (error) => {
      const s = fixture();
      s.max.getExactMessageRow.mockRejectedValue(error);
      await expect(s.service.authorize({ ...s.input, initialQualification: true })).rejects.toBe(
        error,
      );
      expect(s.membership.getMembershipResolution).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, false, true])(
    'retains confirmed null-source absence with initialQualification=%s',
    async (initialQualification) => {
      const s = fixture();
      s.max.getExactMessageRow.mockResolvedValue(null as never);
      await expect(s.service.authorize({ ...s.input, initialQualification })).resolves.toBe(
        'absent',
      );
      expect(s.membership.getMembershipResolution).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
    },
  );

  it('checks the route after fresh membership before final settings and deadline', async () => {
    const s = fixture();
    const route = jest.fn(async () => {
      expect(s.membership.getMembershipResolution).toHaveBeenCalledTimes(2);
      s.settings.requiredSubscriptionEnabled = false;
    });
    await expect(
      s.service.authorize({ ...s.input, beforeFinalAuthority: route }),
    ).rejects.toMatchObject({
      code: 'required_subscription_no_longer_authorized',
    });
    expect(route).toHaveBeenCalledTimes(1);
    expect(s.prisma.chatSettings.findUnique).toHaveBeenCalledTimes(2);
  });

  it('does not extend the original deadline while the final route is checked', async () => {
    const s = fixture();
    let clock: jest.SpyInstance | undefined;
    try {
      await expect(
        s.service.authorize({
          ...s.input,
          beforeFinalAuthority: async () => {
            clock = jest
              .spyOn(Date, 'now')
              .mockReturnValue(s.input.reasons[0]!.metadata.requiredSubscriptionDeadlineAtMs);
          },
        }),
      ).rejects.toMatchObject({ code: 'required_subscription_no_longer_authorized' });
    } finally {
      clock?.mockRestore();
    }
  });
  it('checks all targets fresh through their own routes with at most two concurrent probes', async () => {
    const s = fixture();
    await expect(s.service.authorize(s.input)).resolves.toMatchObject({
      reasonKeys: ['subscription'],
      deadlineAtMs: s.input.reasons[0]!.metadata.requiredSubscriptionDeadlineAtMs,
      reasonDeadlines: [
        {
          reasonKey: 'subscription',
          deadlineAtMs: s.input.reasons[0]!.metadata.requiredSubscriptionDeadlineAtMs,
        },
      ],
    });
    expect(s.membership.getMembershipResolution).toHaveBeenCalledTimes(2);
    expect(s.membership.getMembershipResolution).toHaveBeenCalledWith(
      'target-1',
      'user-1',
      'moderation_required_subscription',
      { forceRefresh: true, allowStaleOnError: false },
    );
  });

  it('preserves each subscription source deadline instead of extending the older reason', async () => {
    const s = fixture();
    const recent = s.input.reasons[0]!;
    const earlier = {
      ...recent,
      reasonKey: 'earlier-subscription',
      metadata: {
        ...recent.metadata,
        requiredSubscriptionSourceAtMs: recent.metadata.requiredSubscriptionSourceAtMs - 60_000,
        requiredSubscriptionDeadlineAtMs: recent.metadata.requiredSubscriptionDeadlineAtMs - 60_000,
      },
    };
    await expect(s.service.authorize({ ...s.input, reasons: [earlier, recent] })).resolves.toEqual({
      reasonKeys: ['earlier-subscription', 'subscription'],
      deadlineAtMs: recent.metadata.requiredSubscriptionDeadlineAtMs,
      reasonDeadlines: [
        {
          reasonKey: 'earlier-subscription',
          deadlineAtMs: earlier.metadata.requiredSubscriptionDeadlineAtMs,
        },
        {
          reasonKey: 'subscription',
          deadlineAtMs: recent.metadata.requiredSubscriptionDeadlineAtMs,
        },
      ],
    });
    expect(s.membership.getMembershipResolution).toHaveBeenCalledTimes(2);
  });
  it.each([
    'joined',
    'disabled',
    'targets',
    'admin',
    'immunity',
    'deadline',
    'changed-during-probe',
  ])('revokes the delete and member sanction after %s', async (change) => {
    const s = fixture();
    if (change === 'joined')
      s.membership.getMembershipResolution.mockResolvedValue({ membership: true, fresh: true });
    if (change === 'disabled') s.settings.requiredSubscriptionEnabled = false;
    if (change === 'targets') s.settings.requiredSubscriptionChannelIds = ['another'];
    if (change === 'admin')
      s.max.getChatMemberAccess.mockResolvedValue({
        userId: 'user-1',
        isAdmin: true,
        isOwner: false,
      });
    if (change === 'immunity') s.immunity.consumeForMessage.mockResolvedValue('granted');
    if (change === 'deadline')
      s.input.reasons[0]!.metadata.requiredSubscriptionDeadlineAtMs = Date.now() - 1;
    if (change === 'changed-during-probe')
      s.membership.getMembershipResolution.mockImplementation(async () => {
        s.settings.requiredSubscriptionEnabled = false;
        return { membership: false, fresh: true };
      });
    await expect(s.service.authorize(s.input)).rejects.toMatchObject({
      code: 'required_subscription_no_longer_authorized',
    });
  });
  it('stops on unavailable evidence and terminal targets, without treating them as missing', async () => {
    const s = fixture();
    s.membership.getMembershipResolution.mockResolvedValue({
      membership: null,
      fresh: false,
    } as never);
    await expect(s.service.authorize(s.input)).rejects.toThrow('fresh membership unavailable');
    s.membership.getLookupIssue.mockReturnValue({ kind: 'terminal' });
    await expect(s.service.authorize(s.input)).rejects.toMatchObject({
      code: 'required_subscription_no_longer_authorized',
    });
  });
});
