import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { readSystemAccessConfig } from '../system/system-access.util';
import { majorNetworksEnabled } from './major-networks-rollout';

export type MajorNetworksRequest = {
  user?: AuthUser;
  miniappProfile?: MiniappProfile;
};

@Injectable()
export class MajorNetworksGuard implements CanActivate {
  private readonly mode: unknown;
  private readonly testUserIds: ReadonlySet<string>;

  constructor(configService: ConfigService) {
    this.mode = configService.get<unknown>('MAJOR_NETWORKS_ROLLOUT') ?? 'off';
    this.testUserIds = readSystemAccessConfig(configService).systemAdminUserIds;
  }

  canActivate(context: ExecutionContext): boolean {
    // FLAG: InitDataGuard authenticates and assigns the profile before this rollout gate.
    const { user, miniappProfile } = context.switchToHttp().getRequest<MajorNetworksRequest>();
    if (
      !user?.userId?.trim() ||
      !miniappProfile ||
      !majorNetworksEnabled(this.mode, miniappProfile, user.userId, this.testUserIds)
    ) {
      throw new ForbiddenException({
        code: 'MAJOR_NETWORKS_UNAVAILABLE',
        message: 'Раздел сетей пока недоступен.',
      });
    }
    return true;
  }
}
