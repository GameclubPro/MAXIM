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

function createLegacyAdminServiceMock(resolvedProfile: typeof profile = profile) {
  return {
    assertChatAdmin: jest.fn().mockResolvedValue(undefined),
    resolveUserProfilesForAdminSurface: jest
      .fn()
      .mockResolvedValue(new Map([['user-1', resolvedProfile]])),
  };
}

function createGlobalSpammerIntelligenceMock() {
  return {
    listReviewQueue: jest.fn().mockImplementation(async (params: { includeLocalProfiles?: boolean }) => ({
      limit: 6,
      items: [
        {
          userId: 'user-1',
          displayName: params.includeLocalProfiles === false ? null : 'Старое имя',
          avatarUrl: null,
          profileUrl: null,
          profileHandoffUrl: null,
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
    })),
    resolveLocalReviewProfiles: jest
      .fn()
      .mockResolvedValue(new Map([['user-1', { userId: 'user-1', displayName: 'Марина Орлова' }]])),
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
  it('uses lightweight local data by default for spammer review candidates', async () => {
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

    expect(globalSpammerIntelligence.listReviewQueue).toHaveBeenCalledWith({
      chatId: 'chat-1',
      status: 'PENDING',
      limit: 6,
      includeObservations: false,
      includeLocalProfiles: true,
    });
    expect(legacyAdminService.resolveUserProfilesForAdminSurface).not.toHaveBeenCalled();
    expect(queue.items[0]).toEqual(
      expect.objectContaining({
        displayName: 'Старое имя',
        avatarUrl: null,
        profileUrl: null,
        profileHandoffUrl: null,
      }),
    );
  });

  it('attaches resolved remote profile data when full spammer review profiles are requested', async () => {
    const legacyAdminService = createLegacyAdminServiceMock();
    const globalSpammerIntelligence = createGlobalSpammerIntelligenceMock();
    const service = new ManualModerationService(
      legacyAdminService as never,
      globalSpammerIntelligence as never,
    );

    const queue = await service.getGlobalSpammerReviewQueue('chat-1', authUser, {
      status: 'PENDING',
      limit: '6',
      profileMode: 'full',
      includeObservations: 'true',
    });

    expect(globalSpammerIntelligence.listReviewQueue).toHaveBeenCalledWith({
      chatId: 'chat-1',
      status: 'PENDING',
      limit: 6,
      includeObservations: true,
      includeLocalProfiles: false,
    });
    expect(queue.items[0]).toEqual(
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

  it('uses lightweight local profile data by default for spammer dossier diagnostics', async () => {
    const legacyAdminService = createLegacyAdminServiceMock();
    const globalSpammerIntelligence = createGlobalSpammerIntelligenceMock();
    const service = new ManualModerationService(
      legacyAdminService as never,
      globalSpammerIntelligence as never,
    );

    const diagnostics = await service.getGlobalSpammerUserDiagnostics('chat-1', 'user-1', authUser);

    expect(globalSpammerIntelligence.getUserDiagnostics).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'user-1',
      options: {
        includeObservations: false,
        includeGraphSignals: false,
        includeReputation: false,
        includeCampaigns: false,
        includeShadow: false,
      },
    });
    expect(legacyAdminService.resolveUserProfilesForAdminSurface).not.toHaveBeenCalled();
    expect(globalSpammerIntelligence.resolveLocalReviewProfiles).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userIds: ['user-1'],
    });
    expect(diagnostics).toEqual(
      expect.objectContaining({
        displayName: profile.displayName,
        avatarUrl: null,
        profileUrl: null,
        profileHandoffUrl: null,
      }),
    );
  });

  it('attaches resolved profile data to full spammer dossier diagnostics when requested', async () => {
    const legacyAdminService = createLegacyAdminServiceMock();
    const globalSpammerIntelligence = createGlobalSpammerIntelligenceMock();
    const service = new ManualModerationService(
      legacyAdminService as never,
      globalSpammerIntelligence as never,
    );

    const diagnostics = await service.getGlobalSpammerUserDiagnostics(
      'chat-1',
      'user-1',
      authUser,
      { mode: 'full' },
    );

    expect(globalSpammerIntelligence.getUserDiagnostics).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'user-1',
      options: {
        includeObservations: true,
        includeGraphSignals: true,
        includeReputation: true,
        includeCampaigns: true,
        includeShadow: true,
      },
    });
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

  it('attaches local profile data without remote lookup for lightweight spammer review lists', async () => {
    const legacyAdminService = createLegacyAdminServiceMock();
    const globalSpammerIntelligence = createGlobalSpammerIntelligenceMock();
    const service = new ManualModerationService(
      legacyAdminService as never,
      globalSpammerIntelligence as never,
    );

    const queue = await service.getGlobalSpammerReviewQueue('chat-1', authUser, {
      status: 'PENDING',
      limit: '20',
      includeObservations: 'false',
      profileMode: 'local',
    });

    expect(globalSpammerIntelligence.listReviewQueue).toHaveBeenCalledWith({
      chatId: 'chat-1',
      status: 'PENDING',
      limit: 20,
      includeObservations: false,
      includeLocalProfiles: true,
    });
    expect(legacyAdminService.resolveUserProfilesForAdminSurface).not.toHaveBeenCalled();
    expect(globalSpammerIntelligence.resolveLocalReviewProfiles).not.toHaveBeenCalled();
    expect(queue.items[0]).toEqual(
      expect.objectContaining({
        displayName: 'Старое имя',
        avatarUrl: null,
      }),
    );
  });

  it('skips profile enrichment and observations when lightweight spammer review lists opt out', async () => {
    const legacyAdminService = createLegacyAdminServiceMock();
    const globalSpammerIntelligence = createGlobalSpammerIntelligenceMock();
    const service = new ManualModerationService(
      legacyAdminService as never,
      globalSpammerIntelligence as never,
    );

    const queue = await service.getGlobalSpammerReviewQueue('chat-1', authUser, {
      status: 'PENDING',
      limit: '20',
      includeProfiles: 'false',
      includeObservations: 'false',
    });

    expect(globalSpammerIntelligence.listReviewQueue).toHaveBeenCalledWith({
      chatId: 'chat-1',
      status: 'PENDING',
      limit: 20,
      includeObservations: false,
      includeLocalProfiles: false,
    });
    expect(legacyAdminService.resolveUserProfilesForAdminSurface).not.toHaveBeenCalled();
    expect(globalSpammerIntelligence.resolveLocalReviewProfiles).not.toHaveBeenCalled();
    expect(queue.items[0]).toEqual(
      expect.objectContaining({
        displayName: null,
        avatarUrl: null,
        lastUserLabel: 'Старое имя',
      }),
    );
  });

  it('skips profile enrichment for lightweight spammer dossier diagnostics', async () => {
    const legacyAdminService = createLegacyAdminServiceMock();
    const globalSpammerIntelligence = createGlobalSpammerIntelligenceMock();
    const service = new ManualModerationService(
      legacyAdminService as never,
      globalSpammerIntelligence as never,
    );

    const diagnostics = await service.getGlobalSpammerUserDiagnostics(
      'chat-1',
      'user-1',
      authUser,
      { includeProfile: 'false', mode: 'full' },
    );

    expect(globalSpammerIntelligence.getUserDiagnostics).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'user-1',
      options: {
        includeObservations: true,
        includeGraphSignals: true,
        includeReputation: true,
        includeCampaigns: true,
        includeShadow: true,
      },
    });
    expect(legacyAdminService.resolveUserProfilesForAdminSurface).not.toHaveBeenCalled();
    expect(diagnostics).toEqual(
      expect.objectContaining({
        userId: 'user-1',
        displayName: null,
        avatarUrl: null,
        profileUrl: null,
        profileHandoffUrl: null,
      }),
    );
  });

  it('attaches local profile data without remote lookup for lightweight spammer dossier diagnostics', async () => {
    const legacyAdminService = createLegacyAdminServiceMock();
    const globalSpammerIntelligence = createGlobalSpammerIntelligenceMock();
    const service = new ManualModerationService(
      legacyAdminService as never,
      globalSpammerIntelligence as never,
    );

    const diagnostics = await service.getGlobalSpammerUserDiagnostics(
      'chat-1',
      'user-1',
      authUser,
      {
        profileMode: 'local',
        includeObservations: 'false',
        includeGraphSignals: 'false',
        includeReputation: 'false',
        includeCampaigns: 'false',
        includeShadow: 'false',
      },
    );

    expect(globalSpammerIntelligence.getUserDiagnostics).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'user-1',
      options: {
        includeObservations: false,
        includeGraphSignals: false,
        includeReputation: false,
        includeCampaigns: false,
        includeShadow: false,
      },
    });
    expect(legacyAdminService.resolveUserProfilesForAdminSurface).not.toHaveBeenCalled();
    expect(globalSpammerIntelligence.resolveLocalReviewProfiles).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userIds: ['user-1'],
    });
    expect(diagnostics).toEqual(
      expect.objectContaining({
        userId: 'user-1',
        displayName: profile.displayName,
        avatarUrl: null,
        profileUrl: null,
        profileHandoffUrl: null,
      }),
    );
  });

  it('drops invalid profile urls instead of failing spammer dossier validation', async () => {
    const legacyAdminService = createLegacyAdminServiceMock({
      displayName: '  Марина Орлова  ',
      avatarUrl: 'not-a-url',
      profileUrl: 'max://user/user-1',
      profileHandoffUrl: 'javascript:alert(1)',
    });
    const globalSpammerIntelligence = createGlobalSpammerIntelligenceMock();
    const service = new ManualModerationService(
      legacyAdminService as never,
      globalSpammerIntelligence as never,
    );

    const queue = await service.getGlobalSpammerReviewQueue('chat-1', authUser, {
      status: 'PENDING',
      limit: '6',
      profileMode: 'full',
    });
    const diagnostics = await service.getGlobalSpammerUserDiagnostics(
      'chat-1',
      'user-1',
      authUser,
      { mode: 'full' },
    );

    expect(queue.items[0]).toEqual(
      expect.objectContaining({
        displayName: 'Марина Орлова',
        avatarUrl: null,
        profileUrl: null,
        profileHandoffUrl: null,
      }),
    );
    expect(diagnostics).toEqual(
      expect.objectContaining({
        displayName: 'Марина Орлова',
        avatarUrl: null,
        profileUrl: null,
        profileHandoffUrl: null,
      }),
    );
  });
});
