import { PublisherSetupRequiredException } from './publisher-errors';
import {
  checkPublisherCommentReadiness,
  PublisherCommentSetupBlockedError,
} from './publisher-comment-readiness';

describe('comment readiness retry admission', () => {
  it.each([
    'policy_disabled',
    'module_disabled',
    'bot_not_connected',
    'bot_not_admin',
    'write_permission_missing',
  ])('marks %s as a persistent pre-mutation refusal', async (blocker) => {
    await expect(
      checkPublisherCommentReadiness(async () => {
        throw new PublisherSetupRequiredException(['target'], blocker);
      }),
    ).rejects.toMatchObject({ blockerCode: blocker, chatIds: ['target'] });
    await expect(
      checkPublisherCommentReadiness(async () => {
        throw new PublisherSetupRequiredException(['target'], blocker);
      }),
    ).rejects.toBeInstanceOf(PublisherCommentSetupBlockedError);
  });

  it.each([
    'bot_access_unconfirmed',
    'bot_access_expired',
    'route_quarantined',
    'publisher_runtime_unavailable',
    'unrecognized_future_code',
  ])('retains retry for %s', async (blocker) => {
    const error = new PublisherSetupRequiredException(['target'], blocker);
    await expect(
      checkPublisherCommentReadiness(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });

  it.each([404, 429, 503])('does not infer policy denial from HTTP %s', async (status) => {
    const error = Object.assign(new Error('request failed'), { response: { status } });
    await expect(
      checkPublisherCommentReadiness(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });

  it('passes the exact route after explicit reactivation without caching old refusal', async () => {
    const route = { requiredBotId: 'publisher', entityType: 'channel' };
    const check = jest
      .fn()
      .mockRejectedValueOnce(new PublisherSetupRequiredException(['target'], 'bot_not_admin'))
      .mockResolvedValueOnce(route);
    await expect(checkPublisherCommentReadiness(check)).rejects.toBeInstanceOf(
      PublisherCommentSetupBlockedError,
    );
    await expect(checkPublisherCommentReadiness(check)).resolves.toBe(route);
  });
});
