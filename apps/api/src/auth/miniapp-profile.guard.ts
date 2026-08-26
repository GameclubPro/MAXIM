import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import type { FastifyRequest } from 'fastify';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { MiniappProfileForbiddenException } from './miniapp-profile.error';
import { MINIAPP_PROFILES_METADATA } from './miniapp-profile';

type ProfiledRequest = FastifyRequest & {
  user?: AuthUser;
  miniappProfile?: MiniappProfile;
};

const DEFAULT_ALLOWED_PROFILES = Object.freeze(['moderation'] as const);

@Injectable()
export class MiniappProfileGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly botRegistry: MaxBotRegistryService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<ProfiledRequest>();
    return this.assertAccess(context, request);
  }

  assertAccess(context: ExecutionContext, request: ProfiledRequest): true {
    const profile = this.resolveProfile(request.user);
    if (!profile) {
      throw new MiniappProfileForbiddenException('Unknown mini app launch profile');
    }

    const allowedProfiles =
      this.reflector.getAllAndOverride<readonly MiniappProfile[]>(MINIAPP_PROFILES_METADATA, [
        context.getHandler(),
        context.getClass(),
      ]) ?? DEFAULT_ALLOWED_PROFILES;
    if (!allowedProfiles.includes(profile)) {
      throw new MiniappProfileForbiddenException();
    }

    request.miniappProfile = profile;
    return true;
  }

  resolveProfile(user: Pick<AuthUser, 'launchBotId'> | null | undefined): MiniappProfile | null {
    const launchBotId = user?.launchBotId?.trim() ?? '';
    if (!launchBotId) {
      return null;
    }
    if (launchBotId === this.botRegistry.getPublisherBotDescriptor().id) {
      return 'publisher';
    }
    return this.botRegistry.getBotById(launchBotId) ? 'moderation' : null;
  }
}
