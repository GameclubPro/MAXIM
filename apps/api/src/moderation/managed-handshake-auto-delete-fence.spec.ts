import { findManagedHandshakeAutoDeleteOwner } from './managed-handshake-auto-delete-fence';
import { MaxClientService } from '../max/max-client.service';

const transportKey = (logicalKey: string) =>
  (
    MaxClientService.prototype as unknown as {
      buildExplicitActionIdempotencyKey(key: string, action: string, botId: string): string;
    }
  ).buildExplicitActionIdempotencyKey(logicalKey, 'SEND_MESSAGE', 'bot-1');

type Row = Record<string, unknown> & { id: string; remoteMessageId: string | null };
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR')
      return (condition as Record<string, unknown>[]).some((part) => matches(row, part));
    if (key === 'AND')
      return (condition as Record<string, unknown>[]).every((part) => matches(row, part));
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      const value = row[key];
      return Object.entries(condition).every(([operator, expected]) => {
        if (operator === 'contains')
          return (
            typeof value === 'string' && value.includes(String(expected).replace(/\\(.)/gu, '$1'))
          );
        if (operator === 'in') return (expected as unknown[]).includes(value);
        if (operator === 'gte') return value instanceof Date && value >= (expected as Date);
        if (operator === 'lte') return value instanceof Date && value <= (expected as Date);
        throw new Error(`Unexpected operator ${operator}`);
      });
    }
    return row[key] === condition;
  });
}

const sourceMessageAt = new Date('2026-10-01T09:00:00.000Z');
const input = {
  chatId: 'chat-1',
  messageId: 'confirmation-1',
  originBotId: 'bot-1',
  sourceMessageAt,
  allowInFlight: true,
};
const receipt: Row = {
  id: 'receipt-1',
  chatId: 'chat-1',
  actionType: 'SEND_MESSAGE',
  sourceTag: 'managed_handshake',
  jobId: transportKey('managed-handshake-start:chat-1:update-1'),
  dispatchBotId: 'bot-1',
  remoteMessageId: 'confirmation-1',
  status: 'SUCCEEDED',
  dispatchStartedAt: new Date(sourceMessageAt.getTime() - 1_000),
  updatedAt: sourceMessageAt,
};
function readerFor(rows: Row[]) {
  return {
    findFirst: jest.fn(async ({ where }) => rows.find((row) => matches(row, where)) ?? null),
  };
}

describe('managed handshake auto-delete protection', () => {
  it.each(['managed-handshake-start', 'publisher-handshake-start'])(
    'protects an old %s receipt after restart without text or a fresh timestamp',
    async (prefix) => {
      const reader = readerFor([
        {
          ...receipt,
          jobId: transportKey(`${prefix}:chat-1:update-1`),
          updatedAt: new Date('2026-09-01'),
        },
      ]);
      await expect(
        findManagedHandshakeAutoDeleteOwner(reader, { ...input, sourceMessageAt: null }),
      ).resolves.toEqual({ id: 'receipt-1', kind: 'managed_handshake' });
      expect(reader.findFirst).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { chatId: 'another-chat' },
    { dispatchBotId: 'another-bot' },
    { remoteMessageId: 'another-message' },
    { sourceTag: 'moderation_notice' },
    { actionType: 'DELETE_MESSAGE' },
    { jobId: transportKey('private-handshake:chat-1:update-1') },
    { jobId: transportKey('managed-handshake-start:chat-10:update-1') },
  ])('does not protect a receipt outside the explicit command scope: %j', async (change) => {
    await expect(
      findManagedHandshakeAutoDeleteOwner(readerFor([{ ...receipt, ...change }]), input),
    ).resolves.toBeNull();
  });

  it.each(['IN_PROGRESS', 'AMBIGUOUS'])(
    'protects a %s send whose webhook beats its receipt',
    async (status) => {
      await expect(
        findManagedHandshakeAutoDeleteOwner(
          readerFor([{ ...receipt, status, remoteMessageId: null }]),
          input,
        ),
      ).resolves.toEqual({ id: 'receipt-1', kind: 'managed_handshake_in_flight' });
    },
  );

  it('closes the race when completion persists between the two reads', async () => {
    const rows: Row[] = [];
    const reader = readerFor(rows);
    reader.findFirst.mockImplementationOnce(async () => {
      rows.push(receipt);
      return null;
    });
    await expect(findManagedHandshakeAutoDeleteOwner(reader, input)).resolves.toEqual({
      id: 'receipt-1',
      kind: 'managed_handshake',
    });
  });

  it.each([
    { dispatchStartedAt: new Date('2026-09-30') },
    { updatedAt: new Date('2026-09-30') },
    { dispatchBotId: 'another-bot' },
    { status: 'FAILED_TERMINAL' },
    { dispatchStartedAt: null },
  ])('does not use an unrelated or rejected pending send: %j', async (change) => {
    const reader = readerFor([
      { ...receipt, remoteMessageId: null, status: 'IN_PROGRESS', ...change },
    ]);
    await expect(findManagedHandshakeAutoDeleteOwner(reader, input)).resolves.toBeNull();
  });

  it.each([null, 'invalid'])(
    'requires a valid source time for unresolved receipts: %s',
    async (time) => {
      const reader = readerFor([{ ...receipt, remoteMessageId: null, status: 'IN_PROGRESS' }]);
      await expect(
        findManagedHandshakeAutoDeleteOwner(reader, { ...input, sourceMessageAt: time }),
      ).resolves.toBeNull();
      expect(reader.findFirst).toHaveBeenCalledTimes(1);
    },
  );

  it('propagates a read failure so deletion cannot proceed without the protection check', async () => {
    const reader = { findFirst: jest.fn().mockRejectedValue(new Error('database unavailable')) };
    await expect(findManagedHandshakeAutoDeleteOwner(reader, input)).rejects.toThrow(
      'database unavailable',
    );
  });
});
