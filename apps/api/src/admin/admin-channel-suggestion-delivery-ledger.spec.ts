import { createPrismaMock } from './admin-service-test-support';
import {
  CHANNEL_SUGGESTION_DELIVERY_DISPATCH_STARTED_CODE,
  CHANNEL_SUGGESTION_DELIVERY_PRE_DISPATCH_CODE,
  assertChannelSuggestionEditorBeforeDispatch,
  persistChannelSuggestionPreclaimFailure,
  reconcileAuthoritativeChannelSuggestionEditorRoster,
  reconcileStaleChannelSuggestionDeliveryClaims,
} from './admin-channel-suggestion-delivery-ledger';

describe('channel suggestion delivery ledger', () => {
  it('scopes global stale scans by audit action without excluding legacy bot keys', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      channelSuggestionAdminDelivery: {
        findMany,
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };

    await reconcileStaleChannelSuggestionDeliveryClaims({
      prisma: prisma as never,
      auditAction: 'CHANNEL_DIALOG_SUGGESTION',
      staleBefore: new Date('2026-08-24T10:10:00.000Z'),
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          auditLog: { action: 'CHANNEL_DIALOG_SUGGESTION' },
          status: 'SENDING',
        }),
      }),
    );
    expect(findMany.mock.calls[0]?.[0]?.where).not.toHaveProperty('botKey');
  });

  it('reclaims stale pre-dispatch claims but keeps started and legacy sends ambiguous', async () => {
    const prisma = createPrismaMock();
    const lockedAt = new Date('2026-08-24T10:00:00.000Z');
    await prisma.channelSuggestionAdminDelivery.createMany({
      data: [
        {
          id: 'pre-dispatch',
          auditLogId: 'suggestion-1',
          adminUserId: 'admin-1',
          botKey: '__default__',
          status: 'SENDING',
          lockedAt,
          lockToken: 'lock-1',
          lastErrorCode: CHANNEL_SUGGESTION_DELIVERY_PRE_DISPATCH_CODE,
        },
        {
          id: 'dispatch-started',
          auditLogId: 'suggestion-1',
          adminUserId: 'admin-2',
          botKey: '__default__',
          status: 'SENDING',
          lockedAt,
          lockToken: 'lock-2',
          lastErrorCode: CHANNEL_SUGGESTION_DELIVERY_DISPATCH_STARTED_CODE,
        },
        {
          id: 'legacy-markerless',
          auditLogId: 'suggestion-1',
          adminUserId: 'admin-3',
          botKey: '__default__',
          status: 'SENDING',
          lockedAt,
          lockToken: 'lock-3',
        },
      ],
      skipDuplicates: true,
    });

    await expect(
      reconcileStaleChannelSuggestionDeliveryClaims({
        prisma: prisma as never,
        auditLogId: 'suggestion-1',
        staleBefore: new Date('2026-08-24T10:10:00.000Z'),
      }),
    ).resolves.toEqual({
      reclaimed: 1,
      ambiguous: 2,
      auditLogIds: ['suggestion-1'],
    });

    await expect(
      prisma.channelSuggestionAdminDelivery.findMany({ where: { auditLogId: 'suggestion-1' } }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'pre-dispatch', status: 'PENDING', lockToken: null }),
        expect.objectContaining({ id: 'dispatch-started', status: 'AMBIGUOUS' }),
        expect.objectContaining({ id: 'legacy-markerless', status: 'AMBIGUOUS' }),
      ]),
    );
  });

  it('does not overwrite a terminal row selected by a detached preclaim worker', async () => {
    const prisma = createPrismaMock();
    await prisma.channelSuggestionAdminDelivery.createMany({
      data: [
        {
          id: 'terminal-row',
          auditLogId: 'suggestion-2',
          adminUserId: 'admin-1',
          botKey: '__default__',
          status: 'FAILED',
          terminal: true,
          lastErrorCode: 'suggestion.delivery.editor_removed',
        },
      ],
      skipDuplicates: true,
    });

    await expect(
      persistChannelSuggestionPreclaimFailure({
        prisma: prisma as never,
        rowIds: ['terminal-row'],
        failure: {
          message: 'temporary connection failure',
          status: 503,
          code: 'suggestion.delivery.preclaim_failed',
          terminal: false,
          recoverable: true,
        },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.channelSuggestionAdminDelivery.findMany({ where: { auditLogId: 'suggestion-2' } }),
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'FAILED',
        terminal: true,
        lastErrorCode: 'suggestion.delivery.editor_removed',
        attemptCount: 0,
      }),
    ]);
  });

  it('fails closed when the final editor access loader is unavailable', async () => {
    await expect(
      assertChannelSuggestionEditorBeforeDispatch({
        adminUserId: 'admin-1',
        knownBotUserIds: new Set(),
        isOwnBotUserId: () => false,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        response: expect.objectContaining({
          status: 503,
          data: expect.objectContaining({
            code: 'suggestion.delivery.editor_recheck_unavailable',
          }),
        }),
      }),
    );
  });

  it('treats an absent requested member in a successful targeted lookup as removed', async () => {
    const prisma = createPrismaMock();
    await prisma.channelSuggestionAdminDelivery.createMany({
      data: [
        {
          id: 'departed-editor-row',
          auditLogId: 'suggestion-3',
          adminUserId: 'departed-editor',
          botKey: '__default__',
          status: 'PENDING',
        },
      ],
      skipDuplicates: true,
    });

    await expect(
      reconcileAuthoritativeChannelSuggestionEditorRoster({
        prisma: prisma as never,
        rosterAdminUserIds: [],
        retryableRows: [{ id: 'departed-editor-row', adminUserId: 'departed-editor' }],
        knownBotUserIds: new Set(),
        isOwnBotUserId: () => false,
        loadMissingAccess: async () => new Map(),
      }),
    ).resolves.toEqual([]);
    await expect(
      prisma.channelSuggestionAdminDelivery.findMany({ where: { auditLogId: 'suggestion-3' } }),
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'FAILED',
        terminal: true,
        lastErrorCode: 'suggestion.delivery.editor_removed',
      }),
    ]);
  });

  it('treats an absent final access result as removed but transport failure as retryable', async () => {
    const base = {
      adminUserId: 'departed-editor',
      knownBotUserIds: new Set<string>(),
      isOwnBotUserId: () => false,
    };
    await expect(
      assertChannelSuggestionEditorBeforeDispatch({
        ...base,
        loadAccess: async () => null,
      }),
    ).rejects.toMatchObject({
      response: { status: 409, data: { code: 'suggestion.delivery.editor_removed' } },
    });
    await expect(
      assertChannelSuggestionEditorBeforeDispatch({
        ...base,
        loadAccess: async () => {
          throw new Error('targeted lookup timeout');
        },
      }),
    ).rejects.toMatchObject({
      response: {
        status: 503,
        data: { code: 'suggestion.delivery.editor_recheck_unavailable' },
      },
    });
  });
});
