import {
  REQUIRED_SUBSCRIPTION_MEDIA_BURST_WINDOW_MS,
  RequiredSubscriptionMediaNoticeCoverageStore,
  bindRequiredSubscriptionMediaNoticeScope,
  buildRequiredSubscriptionMediaNoticeCoverageId,
  createRequiredSubscriptionMediaNoticePlannedState,
  isRequiredSubscriptionMediaNoticeStateCovering,
  markRequiredSubscriptionMediaNoticeDelivered,
  parseRequiredSubscriptionMediaNoticeState,
  resolveRequiredSubscriptionMediaNoticeScope,
  serializeRequiredSubscriptionMediaNoticeState,
} from './required-subscription-media-notice';

function createScope(params: { mediaGroupId?: string | null; createdAtMs?: number } = {}) {
  return resolveRequiredSubscriptionMediaNoticeScope({
    chatId: 'chat-1',
    userId: 'user-1',
    sourceCreatedAt: new Date(params.createdAtMs ?? 1_800_000_000_000).toISOString(),
    mediaGroupId: params.mediaGroupId ?? null,
    mediaEligible: true,
  })!;
}

describe('required subscription media notice scope', () => {
  it('uses a stable opaque scope for an explicit media group', () => {
    const first = createScope({ mediaGroupId: 'album-1' });
    const second = createScope({ mediaGroupId: 'album-1', createdAtMs: 1_800_000_060_000 });
    const other = createScope({ mediaGroupId: 'album-2' });

    expect(first.kind).toBe('media_group');
    expect(first.scopeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(second.scopeDigest).toBe(first.scopeDigest);
    expect(other.scopeDigest).not.toBe(first.scopeDigest);
  });

  it('uses a non-sliding ten-second source-time window for fallback bursts', () => {
    const anchor = createScope();
    const state = markRequiredSubscriptionMediaNoticeDelivered(
      createRequiredSubscriptionMediaNoticePlannedState({
        scope: anchor,
        anchorMessageId: 'message-1',
        noticeIdempotencyKey: 'notice-1',
      }),
    );

    expect(
      isRequiredSubscriptionMediaNoticeStateCovering(
        state,
        createScope({ createdAtMs: anchor.sourceCreatedAtMs + 9_999 }),
      ),
    ).toBe(true);
    expect(
      isRequiredSubscriptionMediaNoticeStateCovering(
        state,
        createScope({
          createdAtMs: anchor.sourceCreatedAtMs + REQUIRED_SUBSCRIPTION_MEDIA_BURST_WINDOW_MS + 1,
        }),
      ),
    ).toBe(false);
  });

  it('separates packages when the required or missing membership set changes', () => {
    const scope = createScope({ mediaGroupId: 'album-1' });
    const first = bindRequiredSubscriptionMediaNoticeScope({
      scope,
      requiredChannelIds: ['channel-2', 'channel-1'],
      missingChannelIds: ['channel-1'],
    });
    const same = bindRequiredSubscriptionMediaNoticeScope({
      scope,
      requiredChannelIds: ['channel-1', 'channel-2'],
      missingChannelIds: ['channel-1'],
    });
    const changed = bindRequiredSubscriptionMediaNoticeScope({
      scope,
      requiredChannelIds: ['channel-1', 'channel-2'],
      missingChannelIds: ['channel-2'],
    });

    expect(same.scopeDigest).toBe(first.scopeDigest);
    expect(changed.scopeDigest).not.toBe(first.scopeDigest);
  });

  it('round-trips planned and delivered states with bounded validation', () => {
    const planned = createRequiredSubscriptionMediaNoticePlannedState({
      scope: createScope({ mediaGroupId: 'album-1' }),
      anchorMessageId: 'message-1',
      noticeIdempotencyKey: 'notice-1',
    });
    expect(
      parseRequiredSubscriptionMediaNoticeState(
        serializeRequiredSubscriptionMediaNoticeState(planned),
      ),
    ).toEqual(planned);

    const delivered = markRequiredSubscriptionMediaNoticeDelivered(planned);
    expect(
      parseRequiredSubscriptionMediaNoticeState(
        serializeRequiredSubscriptionMediaNoticeState(delivered),
      ),
    ).toEqual(delivered);
    expect(parseRequiredSubscriptionMediaNoticeState('{"version":1}')).toBeNull();
  });

  it('returns no scope for non-media or an invalid source timestamp', () => {
    expect(
      resolveRequiredSubscriptionMediaNoticeScope({
        chatId: 'chat-1',
        userId: 'user-1',
        sourceCreatedAt: new Date().toISOString(),
        mediaGroupId: null,
        mediaEligible: false,
      }),
    ).toBeNull();
    expect(
      resolveRequiredSubscriptionMediaNoticeScope({
        chatId: 'chat-1',
        userId: 'user-1',
        sourceCreatedAt: 'invalid',
        mediaGroupId: 'album-1',
        mediaEligible: true,
      }),
    ).toBeNull();
  });
});

describe('RequiredSubscriptionMediaNoticeCoverageStore', () => {
  it('persists one durable delivered coverage record per source message', async () => {
    const rows = new Map<string, { metadata: unknown }>();
    const model = {
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
      ),
      upsert: jest.fn(async (args: { where: { id: string }; create: { metadata?: unknown } }) => {
        const existing = rows.get(args.where.id);
        if (existing) return existing;
        const created = { metadata: args.create.metadata ?? null };
        rows.set(args.where.id, created);
        return created;
      }),
    };
    const store = new RequiredSubscriptionMediaNoticeCoverageStore(model);
    const state = markRequiredSubscriptionMediaNoticeDelivered(
      createRequiredSubscriptionMediaNoticePlannedState({
        scope: createScope({ mediaGroupId: 'album-1' }),
        anchorMessageId: 'message-1',
        noticeIdempotencyKey: 'notice-1',
      }),
    );

    await expect(
      store.persist({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-2',
        state,
      }),
    ).resolves.toEqual(state);
    await expect(store.read('chat-1', 'message-2')).resolves.toEqual(state);
    expect(model.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: buildRequiredSubscriptionMediaNoticeCoverageId('chat-1', 'message-2'),
        },
        create: expect.objectContaining({
          ruleCode: 'REQUIRED_SUBSCRIPTION_NOTICE_COVERAGE',
          messageId: 'message-2',
        }),
      }),
    );
  });
});
