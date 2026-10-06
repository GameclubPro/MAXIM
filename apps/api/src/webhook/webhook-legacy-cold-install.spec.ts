import { WebhookParser } from './webhook.parser';
import {
  inspectLegacyRecoveryCandidate,
  inspectLegacyRecoverySource,
  legacySnapshotDigest,
} from './webhook-legacy-cold-install';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { WebhookLegacyHoldService } from './webhook-legacy-hold.service';

function source() {
  const timestamp = Date.UTC(2026, 9, 5, 19, 11);
  const raw = {
    update_type: 'message_created',
    timestamp,
    message: {
      sender: { user_id: 'legacy-human', name: 'Human', is_bot: false },
      recipient: { chat_id: '-legacy-chat', chat_type: 'chat' },
      timestamp,
      body: { mid: 'legacy-message', text: 'Ordinary original plain text' },
    },
  };
  return {
    botId: 'major-1',
    createdAt: new Date(timestamp + 1000),
    normalizedPayload: new WebhookParser().parse(raw, { botId: 'major-1' }),
    rawPayload: {},
  };
}

function forwardedSource() {
  const receipt = source();
  const raw = receipt.normalizedPayload.raw!;
  const message = raw.message as Record<string, unknown>;
  (message.body as { text: string }).text = '  ';
  const link = {
    type: 'forward',
    chat_id: '-foreign-chat',
    sender: { user_id: 'foreign-author', is_bot: false },
    message: {
      mid: 'foreign-message',
      seq: 1,
      text: 'Original\n  photo caption',
      attachments: [
        {
          type: 'image',
          payload: { photo_id: 42, token: 'synthetic', url: 'https://i.oneme.ru/synthetic-image' },
        },
      ],
    },
  };
  message.link = link;
  receipt.normalizedPayload = new WebhookParser().parse(raw, { botId: receipt.botId });
  return { receipt, raw, message, link };
}

describe('strict legacy cold recovery source', () => {
  it('uses the actual parser for ordinary multiline text', () => {
    const receipt = source();
    const raw = receipt.normalizedPayload.raw!;
    ((raw.message as Record<string, unknown>).body as { text: string }).text =
      '  ordinary\n\t text  ';
    receipt.normalizedPayload = new WebhookParser().parse(raw, { botId: receipt.botId });
    expect(receipt.normalizedPayload.message!.text).toBe('ordinary text');
    expect(inspectLegacyRecoverySource(receipt as never)).not.toBeNull();
    receipt.normalizedPayload.message!.text = 'forged text';
    expect(inspectLegacyRecoverySource(receipt as never)).toBeNull();
  });

  it('binds a flat forwarded image and parser-composed caption only to the outer participant and message', () => {
    const { receipt } = forwardedSource();
    expect(receipt.normalizedPayload.message!.text).toBe('Original photo caption');
    expect(inspectLegacyRecoverySource(receipt as never)).toEqual({
      chatId: '-legacy-chat',
      messageId: 'legacy-message',
      userId: 'legacy-human',
      sourceAt: new Date(Date.UTC(2026, 9, 5, 19, 11)),
    });
  });

  it.each([
    'reply',
    'nested',
    'unknown',
    'video',
    'keyboard',
    'payload',
    'markup',
    'oversize',
    'forged',
  ])('rejects unsupported forwarded content %s', (fault) => {
    const { receipt, link } = forwardedSource();
    if (fault === 'reply') link.type = 'reply';
    if (fault === 'nested') Object.assign(link.message, { link: { type: 'forward' } });
    if (fault === 'unknown') Object.assign(link, { unknown: 'hidden' });
    if (fault === 'video') link.message.attachments[0]!.type = 'video';
    if (fault === 'keyboard') link.message.attachments[0]!.type = 'inline_keyboard';
    if (fault === 'payload')
      Object.assign(link.message.attachments[0]!.payload, { hidden: { user_id: 'foreign' } });
    if (fault === 'markup') Object.assign(link.message, { markup: [] });
    if (fault === 'oversize')
      link.message.attachments = Array.from({ length: 11 }, () => link.message.attachments[0]!);
    if (fault === 'forged') receipt.normalizedPayload.message!.text = 'forged';
    expect(inspectLegacyRecoverySource(receipt as never)).toBeNull();
  });

  it.each(['$', '$ товар', '/command', 'Старт', 'бан', 'тишина 12'])(
    'denies a secondary command or seller trigger inside forwarded content %s',
    (text) => {
      for (const location of ['direct', 'linked']) {
        const { receipt, raw, message, link } = forwardedSource();
        if (location === 'direct') (message.body as { text: string }).text = text;
        else {
          link.message.text = text;
          (message.body as { text: string }).text = 'ordinary prefix';
        }
        receipt.normalizedPayload = new WebhookParser().parse(raw, { botId: receipt.botId });
        expect(inspectLegacyRecoverySource(receipt as never)).toBeNull();
      }
    },
  );

  it('checks configured commands in each content component even when the composed text is ordinary', () => {
    const { receipt, raw, message, link } = forwardedSource();
    (message.body as { text: string }).text = 'ordinary prefix';
    link.message.text = 'особое';
    receipt.normalizedPayload = new WebhookParser().parse(raw, { botId: receipt.botId });
    expect(inspectLegacyRecoverySource(receipt as never)).not.toBeNull();
    expect(
      inspectLegacyRecoverySource(receipt as never, undefined, { adminBanCommandName: 'особое' }),
    ).toBeNull();
  });
  it.each([
    ['recipient', 'user_id', null, 'source_recipient_keys'],
    ['body', 'attachments', null, 'source_attachments'],
    ['body', 'attachments', [{ type: 'image' }], 'source_attachments'],
    ['sender', 'is_bot', undefined, 'source_human_unproved'],
    ['sender', 'is_bot', true, 'source_human_unproved'],
    ['sender', 'name', { private: 'not a scalar' }, 'source_sender_metadata'],
    ['body', 'unknown-private-key', 'private-value', 'source_body_keys'],
  ])(
    'reports a fixed refusal for %s.%s without source metadata',
    (parent, key, value, expected) => {
      const receipt = source();
      const message = receipt.normalizedPayload.raw!.message as Record<
        string,
        Record<string, unknown>
      >;
      message[parent as string]![key as string] = value;
      const reasons = jest.fn();
      expect(inspectLegacyRecoverySource(receipt as never, reasons)).toBeNull();
      expect(reasons.mock.calls).toEqual([[expected]]);
      expect(inspectLegacyRecoverySource(receipt as never)).toBeNull();
    },
  );

  it('requires the direct original shape and timestamps even when raw receipt sampling was off', () => {
    const receipt = source();
    expect(inspectLegacyRecoverySource(receipt as never)).toEqual({
      chatId: '-legacy-chat',
      messageId: 'legacy-message',
      userId: 'legacy-human',
      sourceAt: new Date(Date.UTC(2026, 9, 5, 19, 11)),
    });
    expect(legacySnapshotDigest({ b: 2, a: new Date(0) })).toBe(
      legacySnapshotDigest({ a: new Date(0), b: 2 }),
    );
  });

  it.each(['attachments', 'forward', 'reply', 'target', 'unknown'])(
    'rejects raw secondary identity %s',
    (key) => {
      const receipt = source();
      const message = receipt.normalizedPayload.raw!.message as Record<string, unknown>;
      message[key] = { message_id: 'other-source', user_id: 'other-user' };
      expect(inspectLegacyRecoverySource(receipt as never)).toBeNull();
    },
  );

  it.each(['publisher-bot', 'major-9', undefined, ' major-1 '])(
    'rejects normalized receiver %s that cannot prove the original Major receiver',
    (botId) => {
      const receipt = source();
      receipt.normalizedPayload.botId = botId;
      expect(inspectLegacyRecoverySource(receipt as never)).toBeNull();
    },
  );

  it('keeps ingress receiver provenance independent of a different routed executor', () => {
    const receipt = { ...source(), executionOwnerBotId: 'major-9' };
    expect(inspectLegacyRecoverySource(receipt as never)).not.toBeNull();
  });

  it('never coerces numeric receiver identities into trusted strings', () => {
    const receipt = source();
    expect(
      inspectLegacyRecoverySource({
        ...receipt,
        botId: '123',
        normalizedPayload: { ...receipt.normalizedPayload, botId: 123 },
      } as never),
    ).toBeNull();
    expect(
      inspectLegacyRecoverySource({
        ...receipt,
        botId: 123,
        normalizedPayload: { ...receipt.normalizedPayload, botId: 123 },
      } as never),
    ).toBeNull();
  });

  it('rejects secondary targets hidden inside otherwise allowed metadata keys', () => {
    for (const location of ['seq', 'name', 'last_activity_time', 'update_id']) {
      const receipt = source();
      const raw = receipt.normalizedPayload.raw as Record<string, unknown>;
      const message = raw.message as Record<string, unknown>;
      const parent =
        location === 'seq' ? message.body : location === 'update_id' ? raw : message.sender;
      (parent as Record<string, unknown>)[location] = {
        forward: { message_id: 'secondary', sender_id: 'other-human' },
      };
      expect(inspectLegacyRecoverySource(receipt as never)).toBeNull();
    }
  });

  it.each(['Старт', '/command', '$command', 'тишина 12', 'бан'])(
    'rejects recognizable command %s',
    (text) => {
      const receipt = source();
      const raw = receipt.normalizedPayload.raw as { message: { body: { text: string } } };
      raw.message.body.text = text;
      receipt.normalizedPayload.message!.text = text;
      expect(inspectLegacyRecoverySource(receipt as never)).toBeNull();
    },
  );

  it('rejects future time, edits, bot authors, missing explicit CHAT and conflicting sampled raw', () => {
    const cases = [
      (receipt: ReturnType<typeof source>) => {
        receipt.createdAt = new Date(0);
      },
      (receipt: ReturnType<typeof source>) => {
        receipt.normalizedPayload.type = 'message_edited';
      },
      (receipt: ReturnType<typeof source>) => {
        (receipt.normalizedPayload.raw!.message as { sender: { is_bot: boolean } }).sender.is_bot =
          true;
      },
      (receipt: ReturnType<typeof source>) => {
        delete receipt.normalizedPayload.message!.entityType;
      },
      (receipt: ReturnType<typeof source>) => {
        receipt.rawPayload = { conflict: true };
      },
    ];
    for (const mutate of cases) {
      const receipt = source();
      mutate(receipt);
      expect(inspectLegacyRecoverySource(receipt as never)).toBeNull();
    }
  });

  it('fails bootstrap if an actual protected provider missed mandatory injection', () => {
    const WebhookService = class WebhookService {};
    const provider = new WebhookService();
    const modules = new Map([
      ['test', { providers: new Map([['webhook', { instance: provider }]]) }],
    ]);
    const holds = new WebhookLegacyHoldService({} as never, modules as never);
    expect(() => holds.onApplicationBootstrap()).toThrow('Mandatory legacy hold reader missing');
    Object.assign(provider, { legacyHolds: holds });
    expect(() => holds.onApplicationBootstrap()).not.toThrow();
    expect(WebhookLegacyHoldService.forPrisma({})).toBeUndefined();
  });

  it('requires the shared hold reader in the production private CHAT status provider', () => {
    const PrivateControlService = class PrivateControlService {};
    const provider = new PrivateControlService();
    const modules = new Map([
      ['test', { providers: new Map([['private-control', { instance: provider }]]) }],
    ]);
    const holds = new WebhookLegacyHoldService({} as never, modules as never);
    expect(() => holds.onApplicationBootstrap()).toThrow(
      'Mandatory legacy hold reader missing in PrivateControlService',
    );
    Object.assign(provider, { legacyHolds: holds });
    expect(() => holds.onApplicationBootstrap()).not.toThrow();
  });

  it('returns only the exact CHAT hold presence and rejects unavailable metadata authority', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ held: true }]) };
    const holds = new WebhookLegacyHoldService(prisma as never);
    await expect(holds.hasChatHolds('-selected-chat')).resolves.toBe(true);
    prisma.$queryRaw.mockResolvedValueOnce([{ held: false }]);
    await expect(holds.hasChatHolds('-other-chat')).resolves.toBe(false);
    prisma.$queryRaw.mockResolvedValueOnce([]);
    await expect(holds.hasChatHolds('-selected-chat')).rejects.toThrow(
      'Legacy hold lookup returned no authority',
    );
    const failure = new Error('metadata unavailable');
    prisma.$queryRaw.mockRejectedValueOnce(failure);
    await expect(holds.hasChatHolds('-selected-chat')).rejects.toBe(failure);
  });
});

describe('legacy candidate refusal provenance', () => {
  function candidateDatabase() {
    const receipt = source();
    const owner = {
      ...receipt,
      id: 'private-owner',
      status: 'FAILED',
      errorMessage:
        'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required',
      processedAt: null,
      nextEnqueueAt: null,
      timeoutQuarantineExpiresAt: null,
      semanticKey: buildWebhookSemanticEventKey(receipt.normalizedPayload),
    };
    const claim = {
      id: 'private-claim',
      webhookEventId: owner.id,
      status: 'PENDING',
      businessStartedAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
      completedAt: null,
      commandResult: null,
      enforced: false,
      createdAt: receipt.createdAt,
    };
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ payloadBytes: 1000 }])
        .mockResolvedValue([{ at: new Date(receipt.createdAt.getTime() + 1000) }]),
      webhookEvent: { findUnique: jest.fn().mockResolvedValue(owner) },
      webhookExecutionClaim: {
        findUnique: jest.fn().mockResolvedValueOnce(claim).mockResolvedValue(null),
      },
      moderationDeleteIntent: { findFirst: jest.fn().mockResolvedValue(null) },
      maxActionLedgerEntry: { findFirst: jest.fn().mockResolvedValue(null) },
      chatSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    return { tx, owner, claim };
  }

  it('returns the same eligible candidate without emitting a refusal', async () => {
    const { tx, owner, claim } = candidateDatabase();
    const reasons = jest.fn();
    expect(
      await inspectLegacyRecoveryCandidate(tx as never, owner.id, ['major-1'], reasons),
    ).toMatchObject({ owner, claim });
    expect(reasons).not.toHaveBeenCalled();
  });

  it.each([
    ['status', 'QUEUED', 'candidate_owner_status'],
    ['errorMessage', 'private-error-value', 'candidate_owner_error'],
    ['processedAt', new Date(0), 'candidate_owner_processed'],
    ['nextEnqueueAt', new Date(0), 'candidate_owner_retry'],
    ['timeoutQuarantineExpiresAt', new Date(0), 'candidate_owner_quarantine'],
    ['botId', 'private-other-bot', 'candidate_owner_bot'],
    ['semanticKey', 'private-wrong-key', 'candidate_semantic_key'],
  ])('refuses owner %s before reading its claim', async (field, value, expected) => {
    const { tx, owner } = candidateDatabase();
    Object.assign(owner, { [field as string]: value });
    const reasons = jest.fn();
    expect(
      await inspectLegacyRecoveryCandidate(tx as never, owner.id, ['major-1'], reasons),
    ).toBeNull();
    expect(reasons.mock.calls).toEqual([[expected]]);
    expect(tx.webhookExecutionClaim.findUnique).not.toHaveBeenCalled();
  });

  it('keeps source refusal in the same decision path before the claim lookup', async () => {
    const { tx, owner } = candidateDatabase();
    (
      owner.normalizedPayload.raw!.message as Record<string, Record<string, unknown>>
    ).sender!.is_bot = null;
    const reasons = jest.fn();
    expect(
      await inspectLegacyRecoveryCandidate(tx as never, owner.id, ['major-1'], reasons),
    ).toBeNull();
    expect(reasons.mock.calls).toEqual([['source_human_unproved']]);
    expect(tx.webhookExecutionClaim.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ['webhookEventId', 'private-other-owner', 'candidate_claim_owner'],
    ['status', 'COMPLETED', 'candidate_claim_completed'],
    ['businessStartedAt', new Date(0), 'candidate_claim_started'],
    ['leaseToken', 'private-token', 'candidate_claim_lease'],
    ['leaseExpiresAt', new Date(0), 'candidate_claim_lease'],
    ['completedAt', new Date(0), 'candidate_claim_completed'],
    ['commandResult', { private: 'result' }, 'candidate_claim_command_result'],
  ])('retains the claim %s fence', async (field, value, expected) => {
    const { tx, owner, claim } = candidateDatabase();
    Object.assign(claim, { [field as string]: value });
    const reasons = jest.fn();
    expect(
      await inspectLegacyRecoveryCandidate(tx as never, owner.id, ['major-1'], reasons),
    ).toBeNull();
    expect(reasons.mock.calls).toEqual([[expected]]);
    expect(tx.webhookExecutionClaim.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.moderationDeleteIntent.findFirst).not.toHaveBeenCalled();
  });
});
