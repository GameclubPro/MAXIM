import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentMiniappProfile, MiniappProfiles } from '../auth/miniapp-profile';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { PublisherFeatureV2RequiredException } from '../publisher/publisher-errors';
import { PublicationLegacyService } from './publication-legacy.service';
import { PublicationMetricsInterceptor } from './publication-metrics.interceptor';
import { PublicationService } from './publication.service';

@Controller('v1/publications')
@UseGuards(InitDataGuard)
@UseInterceptors(PublicationMetricsInterceptor)
export class PublicationController {
  constructor(
    private readonly publicationService: PublicationService,
    private readonly publicationLegacyService: PublicationLegacyService,
  ) {}

  @Get()
  @MiniappProfiles('moderation', 'publisher')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    return this.publicationService.list(user, query);
  }

  @Post()
  @MiniappProfiles('moderation', 'publisher')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.publicationService.create(user, body);
  }

  @Post('test')
  @MiniappProfiles('moderation', 'publisher')
  test(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'moderation',
  ) {
    if (profile === 'publisher') {
      throw new PublisherFeatureV2RequiredException();
    }
    return this.publicationService.sendTest(user, body);
  }

  @Post('calendar-availability')
  @MiniappProfiles('moderation', 'publisher')
  calendarAvailability(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.publicationService.getCalendarAvailability(user, body);
  }

  @Get('legacy')
  listLegacy(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    return this.publicationLegacyService.list(user, query);
  }

  @Get(':publicationId')
  @MiniappProfiles('moderation', 'publisher')
  get(@Param('publicationId') publicationId: string, @CurrentUser() user: AuthUser) {
    return this.publicationService.get(publicationId, user);
  }

  @Put(':publicationId')
  @MiniappProfiles('moderation', 'publisher')
  update(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.publicationService.update(publicationId, user, body);
  }

  @Post(':publicationId/pause')
  @MiniappProfiles('moderation', 'publisher')
  pause(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.publicationService.pause(publicationId, user, body);
  }

  @Post(':publicationId/resume')
  @MiniappProfiles('moderation', 'publisher')
  resume(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.publicationService.resume(publicationId, user, body);
  }

  @Post(':publicationId/cancel')
  @MiniappProfiles('moderation', 'publisher')
  cancel(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.publicationService.cancel(publicationId, user, body);
  }

  @Delete(':publicationId')
  @MiniappProfiles('moderation', 'publisher')
  remove(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.publicationService.cancel(publicationId, user, body);
  }

  @Get(':publicationId/deliveries')
  @MiniappProfiles('moderation', 'publisher')
  deliveries(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.publicationService.listDeliveries(publicationId, user, query);
  }

  @Post(':publicationId/occurrences/:occurrenceId/retry')
  @MiniappProfiles('moderation', 'publisher')
  retryOccurrence(
    @Param('publicationId') publicationId: string,
    @Param('occurrenceId') occurrenceId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.publicationService.retryOccurrence(publicationId, occurrenceId, user, body);
  }

  @Post(':publicationId/occurrences/:occurrenceId/resolve-ambiguous')
  @MiniappProfiles('moderation', 'publisher')
  resolveAmbiguous(
    @Param('publicationId') publicationId: string,
    @Param('occurrenceId') occurrenceId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.publicationService.resolveAmbiguousDelivery(
      publicationId,
      occurrenceId,
      user,
      body,
    );
  }
}
