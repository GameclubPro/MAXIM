import type { ConfigService } from '@nestjs/config';
import { PublicationDispatchProfile } from '../prisma/prisma-client';

export const PUBLISHER_SETUP_REQUIRED_CODE = 'PUBLISHER_SETUP_REQUIRED';

export type PublisherDispatchRoute = {
  dispatchProfile: PublicationDispatchProfile;
  requiredBotId: string;
};

export function resolveConfiguredPublisherBotId(configService: ConfigService): string | null {
  const botId = configService.get<string>('MAX_PUBLISHER_BOT_ID')?.trim() ?? '';
  return botId || null;
}

export function resolveNewPublicationDispatchRoute(
  configService: ConfigService,
): PublisherDispatchRoute | null {
  const requiredBotId = resolveConfiguredPublisherBotId(configService);
  return requiredBotId
    ? {
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        requiredBotId,
      }
    : null;
}

export function isPublikDispatchProfile(profile: PublicationDispatchProfile): boolean {
  return profile === PublicationDispatchProfile.PUBLIK_V1;
}
