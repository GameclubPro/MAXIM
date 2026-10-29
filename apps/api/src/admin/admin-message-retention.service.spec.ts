import { ConfigService } from '@nestjs/config';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { AdminMessageRetentionService } from './admin-message-retention.service';
import type { EraserControlService } from '../message-retention/eraser-control.service';
import type { MessageRetentionStore } from '../message-retention/message-retention-store.service';

const user = { userId: 'u1', username: null, displayName: null, launchBotId: 'major' };
function setup() {
  const policy = {
    chatId: '-1',
    enabled: false,
    hours: 48,
    revision: 0,
    activationId: 'old',
    enabledAt: null,
    captureAfter: null,
    pausedAt: null,
    pendingCount: 0,
    deletedCount: 0,
    skippedCount: 0,
    lastStatus: 'off',
  };
  const prisma = {
    chat: { findUnique: jest.fn().mockResolvedValue({ entityType: 'CHAT' }) },
    messageRetentionPolicy: {
      findUnique: jest.fn().mockResolvedValue(policy),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const access = { assertChatAdminAccess: jest.fn() };
  const store: jest.Mocked<Pick<MessageRetentionStore, 'allows' | 'summary' | 'diagnostics'>> & {
    mode: string;
  } = {
    allows: jest.fn().mockReturnValue(false),
    mode: 'off',
    summary: jest
      .fn()
      .mockResolvedValue({ enabled: true, hours: 24, revision: 3, status: 'unavailable' }),
    diagnostics: jest.fn().mockResolvedValue({
      oldestDueAt: null,
      blockerStatus: null,
      hasTerminalReview: false,
      hasUnresolvedReceipt: false,
    }),
  };
  const remote: jest.Mocked<Pick<EraserControlService, 'owns' | 'read' | 'update' | 'resume'>> = {
    owns: jest.fn().mockResolvedValue(false),
    read: jest.fn().mockResolvedValue({ enabled: false, hours: 168, revision: 9, status: 'off' }),
    update: jest.fn().mockResolvedValue({ enabled: true, hours: 168, revision: 10 }),
    resume: jest.fn().mockResolvedValue(null),
  };
  const build = (eraser?: typeof remote, enabled = false) =>
    new AdminMessageRetentionService(
      prisma as never,
      access as never,
      store as unknown as MessageRetentionStore,
      new ConfigService({ ERASER_ENABLED: enabled, MAX_PUBLISHER_BOT_ID: 'publisher' }),
      eraser as unknown as EraserControlService | undefined,
    );
  return { service: build(), build, remote, prisma, access, store, policy };
}

describe('Lastik-only chat retention settings boundary', () => {
  it('reads the persisted owner independently of the execution flag and never falls back after failure', async () => {
    const { build, remote, prisma, store } = setup();
    remote.owns.mockResolvedValue(true);
    const service = build(remote);
    await expect(service.summary('-1')).resolves.toMatchObject({ hours: 168, revision: 9 });
    await expect(service.read('-1', user)).resolves.toMatchObject({ hours: 168, revision: 9 });
    remote.read.mockRejectedValue(new ServiceUnavailableException('unavailable'));
    await expect(service.read('-1', user)).rejects.toMatchObject({ status: 503 });
    expect(prisma.messageRetentionPolicy.findUnique).not.toHaveBeenCalled();
    expect(store.summary).not.toHaveBeenCalled();
  });

  it('keeps an unowned home summary read-only without starting Lastik onboarding', async () => {
    const { build, remote, store } = setup();
    await expect(build(remote, true).summary('-1')).resolves.toEqual({
      enabled: true,
      hours: 24,
      revision: 3,
      status: 'unavailable',
    });
    expect(store.summary).toHaveBeenCalledWith('-1');
    expect(remote.read).not.toHaveBeenCalled();
  });

  it.each([24, 48, 168] as const)(
    'delegates %ih settings and network receipts only to Lastik',
    async (hours) => {
      const { build, remote, prisma, access } = setup();
      const operationId = 'de3db005-54e1-4792-9c79-b306f2c0fb6e';
      const request = {
        enabled: true,
        hours,
        expectedRevision: 9,
        operationId,
        connectWhenReady: true,
      };
      const options = { validateOnly: true, onCommitted: jest.fn() };
      await expect(build(remote, true).update('-1', user, request, options)).resolves.toMatchObject(
        {
          enabled: true,
          revision: 10,
        },
      );
      expect(remote.update).toHaveBeenCalledWith('-1', user.userId, request, options);
      expect(access.assertChatAdminAccess).toHaveBeenCalledWith('-1', user);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.messageRetentionPolicy.update).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    'never changes a legacy policy without Lastik, enabled=%s',
    async (enabled) => {
      const { service, prisma, policy } = setup();
      policy.enabled = true;
      await expect(
        service.update('-1', user, { enabled, hours: 24, expectedRevision: 0 }),
      ).rejects.toMatchObject({ status: 503 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.messageRetentionPolicy.update).not.toHaveBeenCalled();
    },
  );

  it('preserves a disabled Lastik refusal without a legacy write fallback', async () => {
    const { build, remote, prisma } = setup();
    remote.update.mockRejectedValue(new ServiceUnavailableException('Lastik disabled'));
    await expect(
      build(remote).update('-1', user, { enabled: true, hours: 48, expectedRevision: 0 }),
    ).rejects.toMatchObject({ status: 503 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('preserves remote revision conflicts and rejects forged history controls before dispatch', async () => {
    const { build, remote, prisma } = setup();
    remote.update.mockRejectedValue(new ConflictException('revision conflict'));
    const service = build(remote, true);
    await expect(
      service.update('-1', user, { enabled: true, hours: 24, expectedRevision: 8 }),
    ).rejects.toMatchObject({ status: 409 });
    remote.update.mockClear();
    await expect(
      service.update('-1', user, {
        enabled: true,
        hours: 24,
        expectedRevision: 9,
        includeHistory: true,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(remote.update).not.toHaveBeenCalled();
    expect(prisma.messageRetentionPolicy.update).not.toHaveBeenCalled();
  });

  it('keeps a legacy snapshot readable but unavailable without restoring execution', async () => {
    const { service, access, store, policy } = setup();
    policy.enabled = true;
    store.diagnostics.mockResolvedValue({
      oldestDueAt: new Date('2026-09-30T10:00:00Z'),
      blockerStatus: 'error',
      hasTerminalReview: true,
      hasUnresolvedReceipt: false,
    });
    await expect(service.read('-1', user)).resolves.toMatchObject({
      enabled: true,
      status: 'unavailable',
      pendingCount: 0,
      oldestDueAt: '2026-09-30T10:00:00.000Z',
    });
    expect(access.assertChatAdminAccess).toHaveBeenCalledWith('-1', user);
  });

  it('rejects malformed identifiers, Publisher credentials and non-group entities before effects', async () => {
    const { service, prisma, access } = setup();
    await expect(service.read('not-a-chat', user)).rejects.toMatchObject({ status: 400 });
    await expect(service.read('-1', { ...user, launchBotId: 'publisher' })).rejects.toMatchObject({
      status: 403,
    });
    expect(access.assertChatAdminAccess).not.toHaveBeenCalled();
    prisma.chat.findUnique.mockResolvedValue({ entityType: 'CHANNEL' });
    await expect(service.read('-1', user)).rejects.toMatchObject({ status: 400 });
  });

  it('resumes an owned operation by its original identity even when execution is disabled', async () => {
    const { build, remote } = setup();
    remote.owns.mockResolvedValue(true);
    const options = { onCommitted: jest.fn() };
    await build(remote).resumeEraserOperation('-1', user, 'saved-operation', options);
    expect(remote.resume).toHaveBeenCalledWith('-1', user.userId, 'saved-operation', options);
  });
});
