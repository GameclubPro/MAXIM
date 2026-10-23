import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { MarketplaceIntegrationGuard } from './marketplace-integration.guard';
import { StatisticsExchangeGrantsService } from './statistics-exchange-grants.service';
import { StatisticsExchangeStatisticsService } from './statistics-exchange-statistics.service';
import { InitDataGuard } from '../../auth/init-data.guard';
import { MiniappProfiles } from '../../auth/miniapp-profile';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator';

@Controller('v1/integrations/svyazka/v2')
@UseGuards(MarketplaceIntegrationGuard)
export class StatisticsExchangeController {
  constructor(
    private readonly grants: StatisticsExchangeGrantsService,
    private readonly statistics: StatisticsExchangeStatisticsService,
  ) {}
  @Get('entities') entities(@Query() query: unknown) {
    return this.grants.discover(query);
  }
  @Put('grants/:id') put(@Param('id') id: string, @Body() body: unknown) {
    return this.grants.put(z.string().uuid().parse(id), body);
  }
  @Get('grants/:id') grant(@Param('id') id: string) {
    return this.grants.read(z.string().uuid().parse(id));
  }
  @Get('grants/:id/statistics') page(@Param('id') id: string, @Query() query: unknown) {
    return this.statistics.page(z.string().uuid().parse(id), query);
  }
}

@Controller('v1/marketplace/statistics-v2')
@UseGuards(InitDataGuard)
@MiniappProfiles('moderation', 'publisher')
export class StatisticsExchangeOwnerController {
  constructor(
    private readonly grants: StatisticsExchangeGrantsService,
    private readonly statistics: StatisticsExchangeStatisticsService,
  ) {}
  @Get('entities/:kind/:entityId') owner(
    @CurrentUser() user: AuthUser,
    @Param('kind') kind: string,
    @Param('entityId') entityId: string,
  ) {
    return this.statistics.owner(
      user.userId,
      z
        .string()
        .regex(/^-[1-9]\d{0,19}$/u)
        .parse(entityId),
      z.enum(['CHAT', 'CHANNEL']).parse(kind),
    );
  }
  @Get('grants/:id/entities/:kind/:entityId') async selected(
    @CurrentUser() user: AuthUser,
    @Param('id') raw: string,
    @Param('kind') kind: string,
    @Param('entityId') entityId: string,
  ) {
    const id = z.string().uuid().parse(raw);
    const grant = await this.grants.read(id);
    if (grant.actorUserId !== user.userId) throw new ForbiddenException('Доступ запрещён');
    return this.statistics.selected(
      id,
      z
        .string()
        .regex(/^-[1-9]\d{0,19}$/u)
        .parse(entityId),
      z.enum(['CHAT', 'CHANNEL']).parse(kind),
    );
  }
}
