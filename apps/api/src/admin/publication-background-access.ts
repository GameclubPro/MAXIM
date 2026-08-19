import type { PublicationAudienceInput } from '@maxim/contracts/publication';
import { ServiceUnavailableException } from '@nestjs/common';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  ChatEntityType,
  PublicationAudienceMode,
  PublicationAudienceSelection,
} from '../prisma/prisma-client';

type PublicationWarningLogger = {
  warn(context: Record<string, string>, message: string): void;
};

async function resolvePublicationTargetsOrDefer<T>(
  resolve: () => Promise<T>,
  logger: PublicationWarningLogger,
  context: Record<string, string>,
  message: string,
): Promise<T | null> {
  try {
    return await resolve();
  } catch (error: unknown) {
    if (!(error instanceof ServiceUnavailableException)) {
      throw error;
    }
    logger.warn({ ...context, err: error.message }, message);
    return null;
  }
}

function resolvePublicationRecurrenceTargetsOrDefer<T>(
  resolve: () => Promise<T>,
  logger: PublicationWarningLogger,
  schedule: { id: string; publicationId: string },
): Promise<T | null> {
  return resolvePublicationTargetsOrDefer(
    resolve,
    logger,
    { scheduleId: schedule.id, publicationId: schedule.publicationId },
    'Deferred publication recurrence after transient admin access check failure',
  );
}

function resolvePublicationExecutionTargetsOrDefer<T>(
  resolve: () => Promise<T>,
  logger: PublicationWarningLogger,
  occurrence: { id: string; publicationId: string },
): Promise<T | null> {
  return resolvePublicationTargetsOrDefer(
    resolve,
    logger,
    { occurrenceId: occurrence.id, publicationId: occurrence.publicationId },
    'Deferred publication execution after transient admin access check failure',
  );
}

function resolvePublicationOccurrenceTargets<T>(
  publication: {
    actorUserId: string;
    audienceMode: PublicationAudienceMode;
    audienceSelection: PublicationAudienceSelection;
    targets: Array<{ targetChatId: string; entityType: ChatEntityType }>;
  },
  resolvePersisted: (
    user: AuthUser,
    targets: Array<{ targetChatId: string; entityType: ChatEntityType }>,
  ) => Promise<T[]>,
  resolveAudience: (user: AuthUser, audience: PublicationAudienceInput) => Promise<T[]>,
): Promise<T[]> {
  const user: AuthUser = {
    userId: publication.actorUserId,
    username: null,
    displayName: null,
  };
  if (
    publication.audienceMode === PublicationAudienceMode.SNAPSHOT ||
    publication.audienceSelection === PublicationAudienceSelection.SELECTED
  ) {
    return resolvePersisted(user, publication.targets);
  }
  return resolveAudience(user, {
    selection: publication.audienceSelection,
    mode: publication.audienceMode,
    targets: [],
  });
}

export const publicationBackgroundAccess = {
  execution: resolvePublicationExecutionTargetsOrDefer,
  recurrence: resolvePublicationRecurrenceTargetsOrDefer,
  resolveOccurrence: resolvePublicationOccurrenceTargets,
};
