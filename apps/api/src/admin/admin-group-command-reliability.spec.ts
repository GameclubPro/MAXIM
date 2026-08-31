import { BadRequestException } from '@nestjs/common';
import {
  markMaxMemberMutationAttempted,
  markMaxMemberMutationConfirmed,
} from '../max/max-client.service';
import {
  ModerationSanctionStateLockBusyError,
  ModerationSanctionStateLockLeaseLostError,
  ModerationSanctionStateLockUnavailableError,
} from '../moderation/moderation-sanction-state-lock.service';
import { AdminService } from './admin.service';
import {
  createChatContextCacheMock,
  createConfigMock,
  createPrismaMock,
} from './admin-service-test-support';
import { moderationReleaseMessageOptions } from './moderation-release-test.util';

describe('AdminService group command reliability', () => {
  it.each([
    ['busy', new ModerationSanctionStateLockBusyError({ chatId: 'chat-1', userId: 'user-2' })],
    [
      'unavailable',
      new ModerationSanctionStateLockUnavailableError({ chatId: 'chat-1', userId: 'user-2' }),
    ],
    [
      'lost before dispatch',
      new ModerationSanctionStateLockLeaseLostError({ chatId: 'chat-1', userId: 'user-2' }),
    ],
  ])(
    'retries a %s sanction-state lock failure without sending it to the chat',
    async (_case, error) => {
      const prisma = createPrismaMock();
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
      };
      const service = new AdminService(
        prisma as never,
        maxClient as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
      );
      jest.spyOn(service, 'applyManualSystemBan').mockRejectedValue(error);

      await expect(
        service.processManualModerationFanoutJob({
          kind: 'manual_group_moderation_command',
          jobId: 'job-command-lock-contention-1',
          sourceChatId: 'chat-1',
          targetUserId: 'user-2',
          targetSenderName: 'Нарушитель',
          targetMessageId: 'mid-target-1',
          commandMessageId: 'mid-command-1',
          actor: {
            userId: 'admin-1',
            username: null,
            displayName: null,
            chatId: 'chat-1',
            chatTitle: 'Chat 1',
          },
          action: 'BAN',
          muteDurationHours: null,
          deleteBotMessagesEnabled: true,
          deleteBotMessagesDelayMinutes: 3,
        }),
      ).rejects.toBe(error);

      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    },
  );

  it('retries a busy group ban and emits only the eventual success outcome', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const busyError = new ModerationSanctionStateLockBusyError({
      chatId: 'chat-1',
      userId: 'user-2',
    });
    jest
      .spyOn(service, 'applyManualSystemBan')
      .mockRejectedValueOnce(busyError)
      .mockImplementationOnce(async (_chatId, _targetUserId, _actor, _source, options) => {
        options?.onModerationEventRecorded?.('moderation-event-1');
        return {
          ok: true,
          action: 'BAN',
          userId: 'user-2',
          muteDurationHours: null,
          muteExpiresAt: null,
          message: 'Бан включён.',
        };
      });
    const job = {
      kind: 'manual_group_moderation_command' as const,
      jobId: 'job-command-busy-then-success-1',
      sourceChatId: 'chat-1',
      targetUserId: 'user-2',
      targetSenderName: 'Нарушитель',
      targetMessageId: 'mid-target-1',
      commandMessageId: 'mid-command-1',
      actor: {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
      },
      action: 'BAN' as const,
      muteDurationHours: null,
      deleteBotMessagesEnabled: true,
      deleteBotMessagesDelayMinutes: 3,
    };

    await expect(service.processManualModerationFanoutJob(job)).rejects.toBe(busyError);
    await expect(service.processManualModerationFanoutJob(job)).resolves.toBeUndefined();

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('включён бан'),
      expect.anything(),
      expect.anything(),
    );
    expect(maxClient.sendMessage).not.toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('не выполнена'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('recovers a confirmed group ban with a recorded event as success', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest
      .spyOn(service, 'applyManualSystemBan')
      .mockImplementation(async (_chatId, _targetUserId, _actor, _source, options) => {
        options?.onModerationEventRecorded?.('moderation-event-1');
        throw markMaxMemberMutationConfirmed(new Error('post-commit lease handoff'));
      });

    await service.processManualModerationFanoutJob({
      kind: 'manual_group_moderation_command',
      jobId: 'job-command-confirmed-recovery-1',
      sourceChatId: 'chat-1',
      targetUserId: 'user-2',
      targetSenderName: 'Нарушитель',
      targetMessageId: 'mid-target-1',
      commandMessageId: 'mid-command-1',
      actor: {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
      },
      action: 'BAN',
      muteDurationHours: null,
      deleteBotMessagesEnabled: true,
      deleteBotMessagesDelayMinutes: 3,
    });

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('включён бан'),
      moderationReleaseMessageOptions('UNBAN', 'moderation-event-1'),
      expect.anything(),
    );
    expect(maxClient.sendMessage).not.toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('не выполнена'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('reports a definitive attempted member failure instead of calling it uncertain', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest
      .spyOn(service, 'applyManualSystemBan')
      .mockRejectedValue(
        markMaxMemberMutationAttempted(
          new BadRequestException('MAX отклонил бан. Проверьте права бота.'),
        ),
      );

    await service.processManualModerationFanoutJob({
      kind: 'manual_group_moderation_command',
      jobId: 'job-command-definitive-attempt-1',
      sourceChatId: 'chat-1',
      targetUserId: 'user-2',
      targetSenderName: 'Нарушитель',
      targetMessageId: 'mid-target-1',
      commandMessageId: 'mid-command-1',
      actor: {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
      },
      action: 'BAN',
      muteDurationHours: null,
      deleteBotMessagesEnabled: true,
      deleteBotMessagesDelayMinutes: 3,
    });

    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('MAX отклонил бан'),
      expect.anything(),
      expect.anything(),
    );
    expect(maxClient.sendMessage).not.toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('итог не удалось надёжно подтвердить'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('keeps one public outcome when a terminal failure is replayed as success', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest
      .spyOn(service, 'applyManualSystemBan')
      .mockRejectedValueOnce(new BadRequestException('Участник уже вышел из чата.'))
      .mockResolvedValueOnce({
        ok: true,
        action: 'BAN',
        userId: 'user-2',
        muteDurationHours: null,
        muteExpiresAt: null,
        message: 'Бан включён.',
      });
    const job = {
      kind: 'manual_group_moderation_command' as const,
      jobId: 'job-command-single-outcome-1',
      sourceChatId: 'chat-1',
      targetUserId: 'user-2',
      targetSenderName: 'Нарушитель',
      targetMessageId: 'mid-target-1',
      commandMessageId: 'mid-command-1',
      actor: {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
      },
      action: 'BAN' as const,
      muteDurationHours: null,
      deleteBotMessagesEnabled: true,
      deleteBotMessagesDelayMinutes: 3,
    };

    await service.processManualModerationFanoutJob(job);
    await service.processManualModerationFanoutJob(job);

    expect(service.applyManualSystemBan).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('Участник уже вышел из чата'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('retries a pre-dispatch command notice failure without replaying two notices', async () => {
    const prisma = createPrismaMock();
    const noticeError = new Error('notice transport unavailable');
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockRejectedValueOnce(noticeError).mockResolvedValueOnce(undefined),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest.spyOn(service, 'applyManualSystemBan').mockResolvedValue({
      ok: true,
      action: 'BAN',
      userId: 'user-2',
      muteDurationHours: null,
      muteExpiresAt: null,
      message: 'Бан включён.',
    });
    const job = {
      kind: 'manual_group_moderation_command' as const,
      jobId: 'job-command-notice-retry-1',
      sourceChatId: 'chat-1',
      targetUserId: 'user-2',
      targetSenderName: 'Нарушитель',
      targetMessageId: 'mid-target-1',
      commandMessageId: 'mid-command-1',
      actor: {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
      },
      action: 'BAN' as const,
      muteDurationHours: null,
      deleteBotMessagesEnabled: true,
      deleteBotMessagesDelayMinutes: 3,
    };

    await expect(service.processManualModerationFanoutJob(job)).rejects.toBe(noticeError);
    await expect(service.processManualModerationFanoutJob(job)).resolves.toBeUndefined();

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(2);
    await expect(
      prisma.manualModerationFanoutLedgerEntry.count({
        where: { operation: 'COMMAND_NOTICE_OUTCOME' },
      }),
    ).resolves.toBe(1);
  });

  it('does not retry an ambiguous command notice timeout after send dispatch starts', async () => {
    const prisma = createPrismaMock();
    const timeoutError = Object.assign(new Error('socket timed out'), { code: 'ETIMEDOUT' });
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest
        .fn()
        .mockImplementation(
          async (
            _chatId: string,
            _text: string,
            _messageOptions: unknown,
            dispatchOptions: { beforeImmediateSendMutation?: () => Promise<void> },
          ) => {
            await dispatchOptions.beforeImmediateSendMutation?.();
            throw timeoutError;
          },
        ),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest.spyOn(service, 'applyManualSystemBan').mockResolvedValue({
      ok: true,
      action: 'BAN',
      userId: 'user-2',
      muteDurationHours: null,
      muteExpiresAt: null,
      message: 'Бан включён.',
    });

    await expect(
      service.processManualModerationFanoutJob({
        kind: 'manual_group_moderation_command',
        jobId: 'job-command-notice-timeout-1',
        sourceChatId: 'chat-1',
        targetUserId: 'user-2',
        targetSenderName: 'Нарушитель',
        targetMessageId: 'mid-target-1',
        commandMessageId: 'mid-command-1',
        actor: {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatId: 'chat-1',
          chatTitle: 'Chat 1',
        },
        action: 'BAN',
        muteDurationHours: null,
        deleteBotMessagesEnabled: true,
        deleteBotMessagesDelayMinutes: 3,
      }),
    ).resolves.toBeUndefined();

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    await expect(
      prisma.manualModerationFanoutLedgerEntry.count({
        where: { operation: 'COMMAND_NOTICE_OUTCOME', status: 'AMBIGUOUS' },
      }),
    ).resolves.toBe(1);
  });

  it('finishes global MUTE follow-up before recording the terminal success outcome', async () => {
    const prisma = createPrismaMock();
    const fanoutError = new Error('mute fanout enqueue unavailable');
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest.spyOn(service, 'applyManualModerationAction').mockResolvedValue({
      ok: true,
      action: 'MUTE',
      userId: 'user-2',
      muteDurationHours: 6,
      muteExpiresAt: '2026-08-31T04:00:00.000Z',
      message: 'Мут включён на 6 ч.',
    });
    const fanout = jest
      .spyOn((service as any).manualModerationRuntime, 'fanoutGroupMuteAfterNotice')
      .mockRejectedValueOnce(fanoutError)
      .mockResolvedValueOnce(undefined);
    const job = {
      kind: 'manual_group_moderation_command' as const,
      jobId: 'job-command-mute-follow-up-1',
      sourceChatId: 'chat-1',
      targetUserId: 'user-2',
      targetSenderName: 'Нарушитель',
      targetMessageId: 'mid-target-1',
      commandMessageId: 'mid-command-1',
      actor: {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
      },
      action: 'MUTE' as const,
      fanoutAllChats: true,
      muteDurationHours: 6,
      mutePermanent: false,
      deleteBotMessagesEnabled: true,
      deleteBotMessagesDelayMinutes: 3,
    };

    await expect(service.processManualModerationFanoutJob(job)).rejects.toBe(fanoutError);
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    await expect(service.processManualModerationFanoutJob(job)).resolves.toBeUndefined();

    expect(fanout).toHaveBeenCalledTimes(2);
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    await expect(
      prisma.manualModerationFanoutLedgerEntry.count({
        where: { operation: 'COMMAND_NOTICE_OUTCOME', status: 'SUCCEEDED' },
      }),
    ).resolves.toBe(1);
  });

  it('retries an unexpected queued group moderation error without exposing it to the chat', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest
      .spyOn(service, 'applyManualSystemBan')
      .mockRejectedValue(new Error('internal database connection details'));

    await expect(
      service.processManualModerationFanoutJob({
        kind: 'manual_group_moderation_command',
        jobId: 'job-command-internal-failure-1',
        sourceChatId: 'chat-1',
        targetUserId: 'user-2',
        targetSenderName: 'Нарушитель',
        targetMessageId: 'mid-target-1',
        commandMessageId: 'mid-command-1',
        actor: {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatId: 'chat-1',
          chatTitle: 'Chat 1',
        },
        action: 'BAN',
        muteDurationHours: null,
        deleteBotMessagesEnabled: true,
        deleteBotMessagesDelayMinutes: 3,
      }),
    ).rejects.toThrow('internal database connection details');

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['COMMAND_NOTICE_SUCCESS', 'COMMAND_NOTICE_FAILURE'])(
    'does not replace a settled legacy %s row with a new command outcome',
    async (legacyOperation) => {
      const prisma = createPrismaMock();
      await prisma.manualModerationFanoutLedgerEntry.createMany({
        data: [
          {
            operationKey: `legacy-notice:${legacyOperation}`,
            jobId: 'job-command-legacy-notice-1',
            rootIntentKey: null,
            sourceKind: 'manual_group_moderation_command',
            operation: legacyOperation,
            sourceChatId: 'chat-1',
            targetChatId: 'chat-1',
            targetUserId: 'user-2',
            actorUserId: 'admin-1',
            logicalAction: 'NOTICE',
            status: 'SUCCEEDED',
            attemptCount: 1,
            terminal: true,
          },
        ],
        skipDuplicates: true,
      });
      const maxClient = {
        deleteMessage: jest.fn().mockResolvedValue(undefined),
        sendMessage: jest.fn().mockResolvedValue(undefined),
      };
      const service = new AdminService(
        prisma as never,
        maxClient as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
      );
      jest.spyOn(service, 'applyManualSystemBan').mockResolvedValue({
        ok: true,
        action: 'BAN',
        userId: 'user-2',
        muteDurationHours: null,
        muteExpiresAt: null,
        message: 'Бан включён.',
      });

      await service.processManualModerationFanoutJob({
        kind: 'manual_group_moderation_command',
        jobId: 'job-command-legacy-notice-1',
        sourceChatId: 'chat-1',
        targetUserId: 'user-2',
        targetSenderName: 'Нарушитель',
        targetMessageId: 'mid-target-1',
        commandMessageId: 'mid-command-1',
        actor: {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatId: 'chat-1',
          chatTitle: 'Chat 1',
        },
        action: 'BAN',
        muteDurationHours: null,
        deleteBotMessagesEnabled: true,
        deleteBotMessagesDelayMinutes: 3,
      });

      expect(service.applyManualSystemBan).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      await expect(
        prisma.manualModerationFanoutLedgerEntry.count({
          where: { operation: 'COMMAND_NOTICE_OUTCOME' },
        }),
      ).resolves.toBe(0);
    },
  );

  it('recovers pending global MUTE follow-up behind a legacy success notice', async () => {
    const prisma = createPrismaMock();
    const jobId = 'job-command-legacy-mute-success-1';
    await prisma.manualModerationFanoutLedgerEntry.createMany({
      data: [
        {
          operationKey: 'legacy-source-mute-success',
          rootIntentKey: jobId,
          sourceKind: 'group_command',
          operation: 'COMMAND_SOURCE_MUTE',
          sourceChatId: 'chat-1',
          targetChatId: 'chat-1',
          targetUserId: 'user-2',
          actorUserId: 'admin-1',
          logicalAction: 'MUTE',
          status: 'SUCCEEDED',
          attemptCount: 1,
          moderationEventId: 'moderation-event-mute-1',
          terminal: true,
          metadata: {
            source: 'group_command',
            muteDurationHours: 6,
            muteExpiresAt: '2026-08-31T04:00:00.000Z',
            mutePermanent: false,
          },
        },
        {
          operationKey: 'legacy-notice-mute-success',
          jobId,
          sourceKind: 'manual_group_moderation_command',
          operation: 'COMMAND_NOTICE_SUCCESS',
          sourceChatId: 'chat-1',
          targetChatId: 'chat-1',
          targetUserId: 'user-2',
          actorUserId: 'admin-1',
          logicalAction: 'NOTICE',
          status: 'SUCCEEDED',
          attemptCount: 1,
          terminal: true,
        },
      ],
      skipDuplicates: true,
    });
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const fanout = jest
      .spyOn((service as any).manualModerationRuntime, 'fanoutGroupMuteAfterNotice')
      .mockResolvedValue(undefined);

    await service.processManualModerationFanoutJob({
      kind: 'manual_group_moderation_command',
      jobId,
      sourceChatId: 'chat-1',
      targetUserId: 'user-2',
      targetSenderName: 'Нарушитель',
      targetMessageId: 'mid-target-1',
      commandMessageId: 'mid-command-1',
      actor: {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
      },
      action: 'MUTE',
      fanoutAllChats: true,
      muteDurationHours: 6,
      mutePermanent: false,
      deleteBotMessagesEnabled: true,
      deleteBotMessagesDelayMinutes: 3,
    });

    expect(fanout).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    await expect(
      prisma.manualModerationFanoutLedgerEntry.count({
        where: { operation: 'COMMAND_NOTICE_OUTCOME' },
      }),
    ).resolves.toBe(0);
  });
});
