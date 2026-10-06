import { WebhookParser } from './webhook.parser';
import { inspectLegacyRecoverySource, legacySnapshotDigest } from './webhook-legacy-cold-install';
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

describe('strict legacy cold recovery source', () => {
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
