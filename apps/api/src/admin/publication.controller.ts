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
import { PublicationDispatchProfile } from '../prisma/prisma-client';
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
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'moderation',
  ) {
    return this.publicationService.list(user, query, this.toDispatchProfile(profile));
  }

  @Post()
  @MiniappProfiles('publisher')
  create(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'publisher',
  ) {
    return this.publicationService.create(user, body, this.toDispatchProfile(profile));
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
  @MiniappProfiles('publisher')
  calendarAvailability(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'publisher',
  ) {
    return this.publicationService.getCalendarAvailability(
      user,
      body,
      this.toDispatchProfile(profile),
    );
  }

  @Get('legacy')
  @MiniappProfiles('moderation')
  listLegacy(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    return this.publicationLegacyService.list(user, query);
  }

  @Get(':publicationId')
  @MiniappProfiles('moderation', 'publisher')
  get(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @CurrentMiniappProfile() profile: MiniappProfile = 'moderation',
  ) {
    return this.publicationService.get(publicationId, user, this.toDispatchProfile(profile));
  }

  @Put(':publicationId')
  @MiniappProfiles('moderation', 'publisher')
  update(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'moderation',
  ) {
    return this.publicationService.update(
      publicationId,
      user,
      body,
      this.toDispatchProfile(profile),
    );
  }

  @Post(':publicationId/pause')
  @MiniappProfiles('moderation', 'publisher')
  pause(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'moderation',
  ) {
    return this.publicationService.pause(
      publicationId,
      user,
      body,
      this.toDispatchProfile(profile),
    );
  }

  @Post(':publicationId/resume')
  @MiniappProfiles('moderation', 'publisher')
  resume(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'moderation',
  ) {
    return this.publicationService.resume(
      publicationId,
      user,
      body,
      this.toDispatchProfile(profile),
    );
  }

  @Post(':publicationId/cancel')
  @MiniappProfiles('moderation', 'publisher')
  cancel(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'moderation',
  ) {
    return this.publicationService.cancel(
      publicationId,
      user,
      body,
      this.toDispatchProfile(profile),
    );
  }

  @Delete(':publicationId')
  @MiniappProfiles('moderation', 'publisher')
  remove(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'moderation',
  ) {
    return this.publicationService.cancel(
      publicationId,
      user,
      body,
      this.toDispatchProfile(profile),
    );
  }

  @Get(':publicationId/deliveries')
  @MiniappProfiles('moderation', 'publisher')
  deliveries(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'moderation',
  ) {
    return this.publicationService.listDeliveries(
      publicationId,
      user,
      query,
      this.toDispatchProfile(profile),
    );
  }

  @Post(':publicationId/occurrences/:occurrenceId/retry')
  @MiniappProfiles('moderation', 'publisher')
  retryOccurrence(
    @Param('publicationId') publicationId: string,
    @Param('occurrenceId') occurrenceId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'moderation',
  ) {
    return this.publicationService.retryOccurrence(
      publicationId,
      occurrenceId,
      user,
      body,
      this.toDispatchProfile(profile),
    );
  }

  @Post(':publicationId/occurrences/:occurrenceId/resolve-ambiguous')
  @MiniappProfiles('moderation', 'publisher')
  resolveAmbiguous(
    @Param('publicationId') publicationId: string,
    @Param('occurrenceId') occurrenceId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'moderation',
  ) {
    return this.publicationService.resolveAmbiguousDelivery(
      publicationId,
      occurrenceId,
      user,
      body,
      this.toDispatchProfile(profile),
    );
  }

  private toDispatchProfile(profile: MiniappProfile): PublicationDispatchProfile {
    return profile === 'publisher'
      ? PublicationDispatchProfile.PUBLIK_V1
      : PublicationDispatchProfile.LEGACY_ROUTED;
  }
}
