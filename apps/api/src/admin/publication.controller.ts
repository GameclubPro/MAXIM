import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { PublicationLegacyService } from './publication-legacy.service';
import { PublicationService } from './publication.service';

@Controller('v1/publications')
@UseGuards(InitDataGuard)
export class PublicationController {
  constructor(
    private readonly publicationService: PublicationService,
    private readonly publicationLegacyService: PublicationLegacyService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    return this.publicationService.list(user, query);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.publicationService.create(user, body);
  }

  @Post('test')
  test(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.publicationService.sendTest(user, body);
  }

  @Post('calendar-availability')
  calendarAvailability(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.publicationService.getCalendarAvailability(user, body);
  }

  @Get('legacy')
  listLegacy(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    return this.publicationLegacyService.list(user, query);
  }

  @Get(':publicationId')
  get(@Param('publicationId') publicationId: string, @CurrentUser() user: AuthUser) {
    return this.publicationService.get(publicationId, user);
  }

  @Put(':publicationId')
  update(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.publicationService.update(publicationId, user, body);
  }

  @Post(':publicationId/pause')
  pause(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.publicationService.pause(publicationId, user, body);
  }

  @Post(':publicationId/resume')
  resume(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.publicationService.resume(publicationId, user, body);
  }

  @Post(':publicationId/cancel')
  cancel(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.publicationService.cancel(publicationId, user, body);
  }

  @Delete(':publicationId')
  remove(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.publicationService.cancel(publicationId, user, body);
  }

  @Get(':publicationId/deliveries')
  deliveries(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.publicationService.listDeliveries(publicationId, user, query);
  }

  @Post(':publicationId/occurrences/:occurrenceId/retry')
  retryOccurrence(
    @Param('publicationId') publicationId: string,
    @Param('occurrenceId') occurrenceId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.publicationService.retryOccurrence(publicationId, occurrenceId, user, body);
  }

  @Post(':publicationId/occurrences/:occurrenceId/resolve-ambiguous')
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
