import type { Logger } from '@nestjs/common';
import { normalizeMaxUserDisplayName } from '../common/max-user-display-name.util';
import { MAX_API_SOURCE_TAGS, type MaxClientService } from '../max/max-client.service';
import { readTrimmedString } from './admin-legacy-utils';
import { buildUserProfileUrl, normalizeMaxProfileUrl } from './admin-profile-links';
import {
  ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
  CHANNEL_SUGGESTION_ADMIN_LOOKUP_TIMEOUT_MS,
  type ChannelSuggestionActor,
  type ChannelSuggestionAuthorAttribution,
} from './admin.service.support';

type ResolveChannelSuggestionAuthorAttributionParams = {
  chatId: string;
  user: ChannelSuggestionActor;
  botId?: string | null;
  trafficClass: 'interactive' | 'background';
  loadProfiles?: MaxClientService['getChatMemberProfiles'];
  loadLocalDisplayNames(chatId: string, userIds: string[]): Promise<Map<string, string>>;
  logger: Pick<Logger, 'debug'>;
};

export function resolveChannelSuggestionActorDisplayName(
  user: ChannelSuggestionActor,
): string | null {
  return user.displayName?.trim() || null;
}

export async function resolveChannelSuggestionAuthorAttribution(
  params: ResolveChannelSuggestionAuthorAttributionParams,
): Promise<ChannelSuggestionAuthorAttribution> {
  const userId = readTrimmedString(params.user.userId) ?? '';
  const storedDisplayName = normalizeMaxUserDisplayName(
    resolveChannelSuggestionActorDisplayName(params.user),
    userId,
  );
  const storedUsername = readTrimmedString(params.user.username);
  const storedProfileUrl =
    normalizeMaxProfileUrl(readTrimmedString(params.user.profileUrl)) ?? null;
  let remoteDisplayName: string | null = null;
  let remoteUsername: string | null = null;
  let remoteProfileUrl: string | null = null;
  let remoteProfileResolved = false;

  if (userId && params.loadProfiles) {
    try {
      const profiles = await params.loadProfiles(params.chatId, [userId], {
        trafficClass: params.trafficClass,
        actionHealthLane: params.trafficClass,
        sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
        timeoutMs: CHANNEL_SUGGESTION_ADMIN_LOOKUP_TIMEOUT_MS,
        ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
        ...(params.botId ? { botId: params.botId } : {}),
      });
      const profile = profiles.get(userId);
      remoteProfileResolved = Boolean(profile);
      remoteDisplayName = normalizeMaxUserDisplayName(profile?.displayName, userId);
      remoteUsername = readTrimmedString(profile?.username);
      remoteProfileUrl = normalizeMaxProfileUrl(readTrimmedString(profile?.profileUrl)) ?? null;
    } catch (error: unknown) {
      params.logger.debug(
        {
          chatId: params.chatId,
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to refresh channel suggestion author profile',
      );
    }
  }

  let localDisplayName: string | null = null;
  if (userId && !remoteDisplayName) {
    try {
      localDisplayName = normalizeMaxUserDisplayName(
        (await params.loadLocalDisplayNames(params.chatId, [userId])).get(userId),
        userId,
      );
    } catch (error: unknown) {
      params.logger.debug(
        {
          chatId: params.chatId,
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve local channel suggestion author name',
      );
    }
  }

  const username = remoteProfileResolved ? remoteUsername : (remoteUsername ?? storedUsername);
  // FLAG: A failed member lookup must not strip a known MAX name from the author mention.
  const displayName = remoteDisplayName ?? localDisplayName ?? storedDisplayName;
  return {
    userId,
    displayName,
    mentionDisplayName: displayName,
    username,
    profileUrl: remoteProfileResolved
      ? (remoteProfileUrl ?? buildUserProfileUrl(remoteUsername))
      : (remoteProfileUrl ??
        buildUserProfileUrl(remoteUsername) ??
        storedProfileUrl ??
        buildUserProfileUrl(storedUsername)),
  };
}
