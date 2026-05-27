import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { ManualModerationService } from './manual-moderation.service';

@Controller('v1')
@UseGuards(InitDataGuard)
export class AdminManualModerationController {
  constructor(private readonly moderationService: ManualModerationService) {}

  @Get('channels/:chatId/stats')
  getChannelStats(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getChannelStats(chatId, user, query);
  }

  @Get('channels/:chatId/activity-feed')
  getChannelActivityFeed(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getChannelActivityFeed(chatId, user, query);
  }

  @Get('chats/:chatId/activity-feed')
  getChatActivityFeed(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getChatActivityFeed(chatId, user, query);
  }

  @Get('chats/:chatId/moderation-feed')
  getChatModerationFeed(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getChatModerationFeed(chatId, user, query);
  }

  @Get('chats/:chatId/moderation-dashboard')
  getChatModerationDashboard(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getLogsDashboard(chatId, user, {
      ...(query && typeof query === 'object' ? (query as Record<string, unknown>) : {}),
      includeActivityPreview: false,
      includeModerationPreview: true,
    });
  }

  @Get('chats/:chatId/activity-dashboard')
  getChatActivityDashboard(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getLogsDashboard(chatId, user, {
      ...(query && typeof query === 'object' ? (query as Record<string, unknown>) : {}),
      includeActivityPreview: true,
      includeModerationPreview: false,
    });
  }

  @Get('chats/:chatId/members')
  getChatParticipantsPage(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getChatParticipantsPage(chatId, user, query);
  }

  @Put('chats/:chatId/members/:userId/immunity')
  updateChatParticipantImmunity(
    @Param('chatId') chatId: string,
    @Param('userId') targetUserId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.moderationService.updateChatParticipantImmunity(chatId, targetUserId, user, body);
  }

  @Get('chats/:chatId/moderation-events')
  getEvents(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getEvents(chatId, user, query);
  }

  @Get('chats/:chatId/logs-dashboard')
  getLogsDashboard(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getLogsDashboard(chatId, user, query);
  }

  @Post('chats/:chatId/members/:userId/moderation-action')
  applyManualModerationAction(
    @Param('chatId') chatId: string,
    @Param('userId') targetUserId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.moderationService.applyManualModerationAction(chatId, targetUserId, user, body);
  }

  @Post('chats/:chatId/admin-allowlist')
  addAdmin(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.moderationService.addAdmin(chatId, user, body);
  }

  @Delete('chats/:chatId/admin-allowlist/:userId')
  removeAdmin(
    @Param('chatId') chatId: string,
    @Param('userId') targetUserId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.moderationService.removeAdmin(chatId, user, targetUserId);
  }

  @Post('chats/:chatId/domain-allowlist')
  addDomain(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.moderationService.addDomain(chatId, user, body);
  }

  @Get('chats/:chatId/domain-allowlist')
  getDomainAllowlist(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.moderationService.getDomainAllowlist(chatId, user);
  }

  @Get('chats/:chatId/domain-allowlist/details')
  getDomainAllowlistDetails(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.moderationService.getDomainAllowlistDetails(chatId, user);
  }

  @Delete('chats/:chatId/domain-allowlist')
  removeDomainByQuery(
    @Param('chatId') chatId: string,
    @Query('domain') domainQuery: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.moderationService.removeDomain(
      chatId,
      user,
      this.resolveAllowlistDomain(domainQuery),
    );
  }

  @Delete('chats/:chatId/domain-allowlist/:domain')
  removeDomain(
    @Param('chatId') chatId: string,
    @Param('domain') domain: string,
    @Query('domain') domainQuery: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.moderationService.removeDomain(
      chatId,
      user,
      this.resolveAllowlistDomain(domainQuery, domain),
    );
  }

  @Put('chats/:chatId/domain-allowlist/removal-schedule')
  scheduleDomainRemovalByQuery(
    @Param('chatId') chatId: string,
    @Query('domain') domainQuery: string | undefined,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.moderationService.scheduleDomainRemoval(
      chatId,
      user,
      this.resolveAllowlistDomain(domainQuery),
      body,
    );
  }

  @Put('chats/:chatId/domain-allowlist/:domain/removal-schedule')
  scheduleDomainRemoval(
    @Param('chatId') chatId: string,
    @Param('domain') domain: string,
    @Query('domain') domainQuery: string | undefined,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.moderationService.scheduleDomainRemoval(
      chatId,
      user,
      this.resolveAllowlistDomain(domainQuery, domain),
      body,
    );
  }

  private resolveAllowlistDomain(
    queryDomain: string | undefined,
    pathDomain?: string | undefined,
  ): string {
    const normalizedQueryDomain = queryDomain?.trim();
    if (normalizedQueryDomain) {
      return normalizedQueryDomain;
    }

    const normalizedPathDomain = pathDomain?.trim();
    if (normalizedPathDomain) {
      return normalizedPathDomain;
    }

    throw new BadRequestException('Allowlist domain is required');
  }
}
