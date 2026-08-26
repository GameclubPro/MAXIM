import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type {
  MiniappCapability,
  MiniappHomeRoute,
  MiniappProfile,
} from '@maxim/contracts/publisher';

export const MINIAPP_PROFILES_METADATA = 'miniapp:profiles';

export const MiniappProfiles = (...profiles: readonly MiniappProfile[]) =>
  SetMetadata(MINIAPP_PROFILES_METADATA, [...profiles]);

export type MiniappProfileProjection = {
  profile: MiniappProfile;
  capabilities: MiniappCapability[];
  homeRoute: MiniappHomeRoute;
};

export function buildMiniappProfileProjection(profile: MiniappProfile): MiniappProfileProjection {
  return profile === 'publisher'
    ? {
        profile,
        capabilities: ['publisher_workspace', 'publisher_entities', 'chat_comments'],
        homeRoute: '/publications',
      }
    : {
        profile,
        capabilities: ['moderation_workspace', 'publisher_policy_write'],
        homeRoute: '/',
      };
}

export const CurrentMiniappProfile = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): MiniappProfile => {
    const request = ctx.switchToHttp().getRequest<{ miniappProfile: MiniappProfile }>();
    return request.miniappProfile;
  },
);
