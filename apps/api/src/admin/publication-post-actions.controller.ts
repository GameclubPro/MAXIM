import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { MiniappProfiles } from '../auth/miniapp-profile';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { PublicationPostActionCommandsService } from './publication-post-action-commands.service';

@Controller('v1/publications/:publicationId/deliveries/:deliveryId/post-actions')
@UseGuards(InitDataGuard)
@MiniappProfiles('publisher')
export class PublicationPostActionsController {
  constructor(private readonly commands: PublicationPostActionCommandsService) {}

  @Post()
  execute(
    @Param('publicationId') publicationId: string,
    @Param('deliveryId') deliveryId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.commands.execute(publicationId, deliveryId, user, body);
  }
}
