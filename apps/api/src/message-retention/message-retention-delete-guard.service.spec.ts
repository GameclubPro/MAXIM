import { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  MessageRetentionDeleteGuard,
  MessageRetentionGuardError,
} from './message-retention-delete-guard.service';

describe('retired history deletion final guard', () => {
  for (const phase of ['prepare', 'dispatch'] as const)
    it.each([true, false, undefined])(
      `rejects a persisted attempt during ${phase} with ownership %s`,
      async (eraserOwned) => {
        const query = jest
          .fn()
          .mockResolvedValue(eraserOwned === undefined ? [] : [{ eraserOwned }]);
        const prisma = { $queryRaw: query } satisfies Pick<PrismaService, '$queryRaw'>;
        const guard = new MessageRetentionDeleteGuard(prisma as unknown as PrismaService);
        const denied = guard.assertAllowed('old-intent', 'major-bot', phase);
        await expect(denied).rejects.toMatchObject({
          code: 'message_retention_guard_rejected',
          reasonCode: 'runtime_retired',
          disposition: 'skip',
          message: eraserOwned
            ? 'History cleanup belongs to Lastik; Major execution is retired'
            : 'Legacy history cleanup is retired',
        });
        await expect(denied).rejects.toBeInstanceOf(MessageRetentionGuardError);
        expect(query).toHaveBeenCalledTimes(1);
        const statement = query.mock.calls[0]![0] as Prisma.Sql;
        expect(statement.values).toEqual(['old-intent']);
        expect(statement.text).toContain('WHERE intent."id" = $1');
        expect(statement.text).toContain('LIMIT 1');
      },
    );

  it('fails closed when the local ownership observation is unavailable', async () => {
    const failure = new Error('database unavailable');
    const prisma = { $queryRaw: jest.fn().mockRejectedValue(failure) } satisfies Pick<
      PrismaService,
      '$queryRaw'
    >;
    const guard = new MessageRetentionDeleteGuard(prisma as unknown as PrismaService);
    await expect(guard.assertAllowed('old-intent', 'major-bot')).rejects.toBe(failure);
  });
});
