import { ChatEntityType, ManagedPollStatus } from '../prisma/prisma-client';
import { ManagedPollService } from './managed-poll.service';

describe('managed poll rendering after an uncertain MAX result', () => {
  afterEach(() => jest.useRealTimers());

  it.each([true, false])(
    'backs off without losing the publication; shared Redis available=%s',
    async (shared) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-13T00:00:00Z'));
      const cache = new Map<string, string>();
      const redis = {
        getString: jest.fn(async (key: string) => {
          if (!shared) throw new Error('Redis unavailable');
          return cache.get(key) ?? null;
        }),
        setStringWithTtl: jest.fn(async (key: string, value: string) => {
          if (!shared) throw new Error('Redis unavailable');
          cache.set(key, value);
        }),
      };
      const poll = {
        id: 'poll',
        chatId: 'chat',
        actorUserId: 'author',
        chat: { entityType: ChatEntityType.CHAT },
        question: 'Question?',
        questionFormat: 'plain',
        status: ManagedPollStatus.ACTIVE,
        resultOptions: [{ id: 'option', position: 0, text: 'Yes', votes: 1, percent: 100 }],
        publicationMessageId: 'message',
        publicationBotId: 'bot',
        publicationUrl: null,
        renderRevision: 2,
      };
      const prisma = { managedPoll: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
      const maxClient = {
        editMessageInlineKeyboard: jest.fn().mockRejectedValue({ response: { status: 404 } }),
        getExactMessagePresence: jest.fn().mockRejectedValue({ response: { status: 503 } }),
      };
      const accessLoss = { recordIfManagedEntityAccessLost: jest.fn() };
      const makeService = () => {
        const service = new ManagedPollService(
          prisma as never,
          maxClient as never,
          {} as never,
          {} as never,
          accessLoss as never,
          redis as never,
        );
        jest
          .spyOn(service as any, 'loadPollAggregate')
          .mockImplementation(async () => ({ ...poll }));
        jest.spyOn(service as any, 'markPollRendered').mockResolvedValue(true);
        return service as any;
      };
      const first = makeService();
      await expect(first.renderPollPublication('chat', 'poll', 'background-repair')).resolves.toBe(
        false,
      );
      expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
      expect(accessLoss.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
      const next = shared ? makeService() : first;
      poll.renderRevision += 1;
      await expect(next.renderPollPublication('chat', 'poll', 'background-repair')).resolves.toBe(
        false,
      );
      expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
      expect(prisma.managedPoll.updateMany.mock.calls[0][0].data).not.toHaveProperty(
        'publicationMessageId',
      );
      maxClient.editMessageInlineKeyboard.mockResolvedValue(undefined);
      poll.publicationMessageId = 'replacement';
      await expect(next.renderPollPublication('chat', 'poll', 'background-repair')).resolves.toBe(
        true,
      );
      expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(2);
      poll.publicationMessageId = 'message';
      jest.setSystemTime(Date.now() + 5 * 60_000 + 1);
      await expect(next.renderPollPublication('chat', 'poll', 'background-repair')).resolves.toBe(
        true,
      );
      expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(3);
    },
  );
});
