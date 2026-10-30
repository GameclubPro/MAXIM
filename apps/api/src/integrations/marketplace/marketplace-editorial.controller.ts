import {
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { marketplaceProfileSchema } from '@maxim/contracts/marketplace-integration';
import { InitDataGuard } from '../../auth/init-data.guard';
import { MiniappProfiles } from '../../auth/miniapp-profile';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator';
import { MarketplaceIntegrationGuard } from './marketplace-integration.guard';
import { MarketplaceEditorialAccessService } from './marketplace-editorial-access.service';
import { MarketplaceEditorialService } from './marketplace-editorial.service';

@Controller('v1/integrations/svyazka/v1')
@UseGuards(MarketplaceIntegrationGuard)
export class MarketplaceEditorialIntegrationController {
  constructor(private readonly access: MarketplaceEditorialAccessService) {}
  @Header('Cache-Control', 'no-store')
  @Post('editorial-access')
  prove(@Body() raw: unknown) {
    return this.access.prove(raw);
  }
}
@Controller('v1/marketplace')
@UseGuards(InitDataGuard)
@MiniappProfiles('moderation', 'publisher')
export class MarketplaceEditorialController {
  constructor(private readonly editorial: MarketplaceEditorialService) {}
  @Header('Cache-Control', 'no-store')
  @Get('entities/:kind/:entityId/editorial')
  get(
    @CurrentUser() user: AuthUser,
    @Param('kind') kind: string,
    @Param('entityId') entityId: string,
    @Query('profile') profile: unknown,
    @Req() request: { miniappProfile?: string },
  ) {
    return this.editorial.get(user.userId, kind, entityId, this.profile(profile, request));
  }
  @Header('Cache-Control', 'no-store')
  @Patch('entities/:kind/:entityId/editorial')
  patch(
    @CurrentUser() user: AuthUser,
    @Param('kind') kind: string,
    @Param('entityId') entityId: string,
    @Query('profile') profile: unknown,
    @Body() body: unknown,
    @Req() request: { miniappProfile?: string },
  ) {
    return this.editorial.mutate(user.userId, kind, entityId, this.profile(profile, request), body);
  }
  private profile(input: unknown, request: { miniappProfile?: string }) {
    const profile = marketplaceProfileSchema.parse(input ?? request.miniappProfile);
    if (profile !== request.miniappProfile)
      throw new ConflictException('Профиль запуска не совпадает');
    return profile;
  }
}
