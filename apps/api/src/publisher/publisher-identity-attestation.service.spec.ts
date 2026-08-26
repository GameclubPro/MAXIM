import { PublisherIdentityAttestationService } from './publisher-identity-attestation.service';

describe('PublisherIdentityAttestationService', () => {
  const previousRole = process.env.APP_ROLE;
  const previousServiceName = process.env.APP_SERVICE_NAME;

  beforeEach(() => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
  });

  afterAll(() => {
    if (previousRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = previousRole;
    if (previousServiceName === undefined) delete process.env.APP_SERVICE_NAME;
    else process.env.APP_SERVICE_NAME = previousServiceName;
  });

  function createHarness(identity: unknown | Error) {
    const maxClient = {
      getOwnProfileIdentity:
        identity instanceof Error
          ? jest.fn().mockRejectedValue(identity)
          : jest.fn().mockResolvedValue(identity),
    };
    const credentials = {
      getBotId: jest.fn(() => 'se14088825_bot'),
      getRequiredActionToken: jest.fn(() => 'not-a-real-token'),
    };
    const dispatchHealth = {
      recordAuthenticatedSuccess: jest.fn().mockResolvedValue(undefined),
      recordGlobalIdentityAttestationFailure: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PublisherIdentityAttestationService(
      maxClient as never,
      credentials as never,
      dispatchHealth as never,
    );
    return { service, maxClient, credentials, dispatchHealth };
  }

  it('attests an exact official username variant and memoizes the result', async () => {
    const { service, maxClient, dispatchHealth } = createHarness({
      userIds: ['14088825'],
      username: 'se14088825_bot',
    });

    await service.assertAttested();
    await service.assertAttested();

    expect(maxClient.getOwnProfileIdentity).toHaveBeenCalledTimes(1);
    expect(maxClient.getOwnProfileIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'se14088825_bot',
        sourceTag: 'publisher_identity_attestation',
      }),
    );
    expect(dispatchHealth.recordAuthenticatedSuccess).toHaveBeenCalledTimes(1);
  });

  it('fails closed and persists a bot-scoped pause on identity mismatch', async () => {
    const { service, dispatchHealth } = createHarness({
      userIds: ['999999'],
      username: 'another_bot',
    });

    await expect(service.assertAttested()).rejects.toMatchObject({
      code: 'PUBLISHER_IDENTITY_ATTESTATION_FAILED',
      failure: 'identity_mismatch',
      message: 'Publik action-token identity attestation failed',
    });
    expect(dispatchHealth.recordGlobalIdentityAttestationFailure).toHaveBeenCalledWith(
      'identity_mismatch',
      null,
      expect.any(Date),
    );
    expect(dispatchHealth.recordAuthenticatedSuccess).not.toHaveBeenCalled();
  });

  it('globally pauses an authorization failure without exposing the remote response', async () => {
    const error = Object.assign(new Error('response contained sensitive data'), {
      response: { status: 401 },
    });
    const { service, dispatchHealth } = createHarness(error);

    await expect(service.assertAttested()).rejects.toMatchObject({
      failure: 'authorization_failed',
      message: 'Publik action-token identity attestation failed',
    });
    expect(dispatchHealth.recordGlobalIdentityAttestationFailure).toHaveBeenCalledWith(
      'identity_authorization_failed',
      401,
      expect.any(Date),
    );
  });

  it('keeps transient lookup failures closed without writing an authorization pause', async () => {
    const { service, dispatchHealth } = createHarness(new Error('timeout'));

    await expect(service.assertAttested()).rejects.toMatchObject({
      failure: 'transient_failure',
    });
    expect(dispatchHealth.recordGlobalIdentityAttestationFailure).not.toHaveBeenCalled();
    expect(dispatchHealth.recordAuthenticatedSuccess).not.toHaveBeenCalled();
  });

  it('sanitizes pause-storage failures after a matching remote identity', async () => {
    const { service, dispatchHealth } = createHarness({
      userIds: [],
      username: 'se14088825_bot',
    });
    dispatchHealth.recordAuthenticatedSuccess.mockRejectedValueOnce(
      new Error('redis://user:password@internal-host'),
    );

    await expect(service.assertAttested()).rejects.toMatchObject({
      failure: 'transient_failure',
      message: 'Publik action-token identity attestation failed',
    });
  });
});
