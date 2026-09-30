import { digestDuplicateContent } from './message-duplicate-content';
import { MessageDuplicateAdmissionService } from './message-duplicate-admission.service';

type AdmissionRow = {
  chatId: string;
  messageId: string;
  messageActionKey: string | null;
  ruleCode: string;
  updateType: string;
  createdAt: Date;
};

function setup() {
  const rows = new Map<string, AdmissionRow>();
  const admittedAt = new Date('2026-09-30T15:00:00Z');
  const createMany = jest.fn(
    async ({ data }: { data: Array<AdmissionRow & { dedupeKey: string }> }) => {
      let count = 0;
      for (const row of data) {
        if (rows.has(row.dedupeKey)) continue;
        rows.set(row.dedupeKey, { ...row, createdAt: admittedAt });
        count += 1;
      }
      return { count };
    },
  );
  const findUnique = jest.fn(
    async ({ where }: { where: { dedupeKey: string } }) => rows.get(where.dedupeKey) ?? null,
  );
  const service = new MessageDuplicateAdmissionService({
    moderationViolationMessageClaim: { createMany, findUnique },
  } as never);
  const input = { jobId: 'job', chatId: '-123', messageId: 'message' };
  const key = `message-duplicate-admission:v1:${digestDuplicateContent(input.jobId)}`;
  return { service, input, key, rows, createMany, findUnique, admittedAt };
}

describe('durable duplicate initial admission', () => {
  it('grants initial admission once and keeps the committed clock on replay', async () => {
    const s = setup();
    const first = await s.service.register(s.input);
    expect(first).toEqual({ registration: 'initial', admittedAtMs: s.admittedAt.getTime() });
    expect(await s.service.register(s.input)).toEqual({ ...first, registration: 'retry' });
    expect(s.rows.size).toBe(1);
    expect(s.rows.get(s.key)?.messageActionKey).toBeNull();
  });

  it('resolves concurrent registration to exactly one initial admission', async () => {
    const s = setup();
    const results = await Promise.all(Array.from({ length: 8 }, () => s.service.register(s.input)));
    expect(results.filter((result) => result.registration === 'initial')).toHaveLength(1);
    expect(results.filter((result) => result.registration === 'retry')).toHaveLength(7);
    expect(new Set(results.map((result) => result.admittedAtMs))).toEqual(
      new Set([s.admittedAt.getTime()]),
    );
  });

  it('does not mint another initial admission after a lost post-commit response', async () => {
    const s = setup();
    const create = s.createMany.getMockImplementation()!;
    s.createMany.mockImplementationOnce(async (input) => {
      await create(input);
      throw new Error('Synthetic lost commit response');
    });
    await expect(s.service.register(s.input)).rejects.toThrow('lost commit response');
    expect(await s.service.register(s.input)).toEqual({
      registration: 'retry',
      admittedAtMs: s.admittedAt.getTime(),
    });
  });

  it('keeps new jobs independent while replays retain their original admission', async () => {
    const s = setup();
    await s.service.register(s.input);
    expect(
      await s.service.register({ ...s.input, jobId: 'another-job', messageId: 'another-message' }),
    ).toMatchObject({ registration: 'initial' });
    expect(await s.service.register(s.input)).toMatchObject({ registration: 'retry' });
  });

  it('fails closed when its committed row cannot be reconciled', async () => {
    const s = setup();
    s.findUnique.mockResolvedValue(null);
    await expect(s.service.register(s.input)).rejects.toThrow('could not be reconciled');
  });

  it.each([
    { chatId: '-456' },
    { messageId: 'another-message' },
    { messageActionKey: 'other-rule-owner' },
    { ruleCode: 'ANOTHER_RULE' },
    { updateType: 'message_action' },
  ])('rejects a row with incompatible ownership: %j', async (change) => {
    const s = setup();
    await s.service.register(s.input);
    Object.assign(s.rows.get(s.key)!, change);
    await expect(s.service.register(s.input)).rejects.toThrow('could not be reconciled');
  });
});
