import { ManualModerationService } from './manual-moderation.service';

const authUser = {
  userId: 'admin-1',
  username: null,
  displayName: null,
  chatTitle: null,
};

const profile = {
  displayName: 'Марина Орлова',
  avatarUrl: 'https://cdn.max.ru/u/user-1/avatar.jpg',
  profileUrl: 'https://max.ru/marina-orlova',
  profileHandoffUrl: 'https://max.ru/777000_bot?start=pm2_user_1',
};

function createLegacyAdminServiceMock() {
  return {
    assertChatAdmin: jest.fn().mockResolvedValue(undefined),
    resolveUserProfilesForAdminSurface: jest.fn().mockResolvedValue(new Map([['user-1', profile]])),
  };
}

function createGlobalSpammerIntelligenceMock() {
  return {
    listReviewQueue: jest.fn().mockResolvedValue({
      limit: 6,
      items: [
        {
          userId: 'user-1',
          status: 'PENDING',
          confidenceScore: 0.74,
          sourceBreakdown: {},
          lastReason: 'COMMERCIAL_AD_DETECTED',
          lastChatId: 'chat-1',
          lastEvidence: null,
          lastUserLabel: 'Старое имя',
          suppressedUntil: null,
          reviewedAt: null,
          reviewedByUserId: null,
          reviewReason: null,
          falsePositive: false,
          chats: [],
          observations: [],
        },
      ],
    }),
    getUserDiagnostics: jest.fn().mockResolvedValue({
      userId: 'user-1',
      chatId: 'chat-1',
      policy: {
        userId: 'user-1',
        chatId: 'chat-1',
        trigger: 'diagnostics',
        registryStatus: 'MEDIUM_REVIEW',
        action: 'NONE',
        enforcementMode: 'enforce',
        policyBand: 'MEDIUM',
        deleteSpammersEnabled: true,
        adminExempt: false,
        shadow: false,
        wouldEnforce: false,
        enforced: false,
        confidenceScore: 0.74,
        shadowScore: null,
        reason: 'COMMERCIAL_AD_DETECTED',
        expiresAt: null,
        sourceBreakdown: {},
        campaignBreakdown: null,
      },
      registry: {
        active: false,
        expired: false,
        confidenceScore: null,
        confirmedAt: null,
        confirmedByUserId: null,
        reason: null,
        expiresAt: null,
        sourceBreakdown: null,
      },
      candidate: {
        status: 'PENDING',
        confidenceScore: 0.74,
        lastReason: 'COMMERCIAL_AD_DETECTED',
        reviewedAt: null,
        reviewedByUserId: null,
        reviewReason: null,
        falsePositive: false,
      },
      activeSuppression: null,
      observations: [],
      graphSignals: [],
      sourceReputation: [],
      campaigns: [],
      latestShadowScore: null,
      localAdminDecision: null,
    }),
  };
}

describe('ManualModerationService spammer profiles', () => {
  it('attaches resolved profile data to spammer review candidates and diagnostics', async () => {
    const legacyAdminService = createLegacyAdminServiceMock();
    const globalSpammerIntelligence = createGlobalSpammerIntelligenceMock();
    const service = new ManualModerationService(
      legacyAdminService as never,
      globalSpammerIntelligence as never,
    );

    const queue = await service.getGlobalSpammerReviewQueue('chat-1', authUser, {
      status: 'PENDING',
      limit: '6',
    });
    const diagnostics = await service.getGlobalSpammerUserDiagnostics('chat-1', 'user-1', authUser);

    expect(queue.items[0]).toEqual(
      expect.objectContaining({
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        profileUrl: profile.profileUrl,
        profileHandoffUrl: profile.profileHandoffUrl,
      }),
    );
    expect(diagnostics).toEqual(
      expect.objectContaining({
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        profileUrl: profile.profileUrl,
        profileHandoffUrl: profile.profileHandoffUrl,
      }),
    );
    expect(legacyAdminService.resolveUserProfilesForAdminSurface).toHaveBeenCalledWith(
      'chat-1',
      'chat',
      ['user-1'],
      { allowRemoteLookup: true },
    );
  });
});
