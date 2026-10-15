import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { MiniappProfiles } from '../auth/miniapp-profile';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { ManagedEntityPresentationService } from './managed-entity-presentation.service';

@Controller('v1/managed-entities')
@UseGuards(InitDataGuard)
@MiniappProfiles('moderation')
export class ManagedEntityPresentationController {
  constructor(private readonly presentation: ManagedEntityPresentationService) {}

  @Post('presentation')
  read(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.presentation.read(user, body);
  }
}
