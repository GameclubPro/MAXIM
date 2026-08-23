import { Controller, Delete, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator';
import { KaravanStorefrontAllowlistService } from './karavan-storefront-allowlist.service';

@Controller('v1')
@UseGuards(InitDataGuard)
export class KaravanStorefrontAllowlistController {
  constructor(private readonly allowlistService: KaravanStorefrontAllowlistService) {}

  @Get('chats/:chatId/karavan-storefront/allowlist')
  list(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query('cursor') cursor?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('includeExpired') includeExpired?: string,
  ) {
    return this.allowlistService.list(chatId, user, {
      cursor,
      limit,
      includeExpired: includeExpired === 'true' || includeExpired === '1',
    });
  }

  @Delete('chats/:chatId/karavan-storefront/allowlist/:entryId')
  revoke(
    @Param('chatId') chatId: string,
    @Param('entryId') entryId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.allowlistService.revoke(chatId, entryId, user);
  }
}
