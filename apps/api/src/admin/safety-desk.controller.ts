import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { SafetyDeskAdminGuard } from './safety-desk-admin.guard';
import { SafetyDeskService } from './safety-desk.service';

@Controller('v1/safety-desk')
@UseGuards(SafetyDeskAdminGuard)
export class SafetyDeskController {
  constructor(private readonly safetyDeskService: SafetyDeskService) {}

  @Get('queue')
  getQueue() {
    return this.safetyDeskService.getQueue();
  }

  @Get('runtime/deletes')
  getDeleteRuntime() {
    return this.safetyDeskService.getDeleteRuntime();
  }

  @Get('runtime/night-mode-transitions')
  getNightModeTransitionRuntime(@Query('offset') offset: string | undefined) {
    return this.safetyDeskService.getNightModeTransitionRuntime(offset);
  }

  @Post('runtime/night-mode-transitions/:chatId/acknowledge')
  acknowledgeNightModeTransitionBlock(
    @Param('chatId') chatId: string,
    @Headers('x-remote-user') remoteUser: string | undefined,
    @Body() body: unknown,
  ) {
    return this.safetyDeskService.acknowledgeNightModeTransitionBlock(
      chatId,
      remoteUser ?? null,
      body,
    );
  }

  @Post('runtime/night-mode-transitions/:chatId/retry')
  retryNightModeTransitionBlock(
    @Param('chatId') chatId: string,
    @Headers('x-remote-user') remoteUser: string | undefined,
    @Body() body: unknown,
  ) {
    return this.safetyDeskService.retryNightModeTransitionBlock(chatId, remoteUser ?? null, body);
  }

  @Post('runtime/ambiguous-sends/:itemId/allow-retry')
  clearAmbiguousSendFence(
    @Param('itemId') itemId: string,
    @Headers('x-remote-user') remoteUser: string | undefined,
    @Body() body: unknown,
  ) {
    return this.safetyDeskService.clearAmbiguousSendFence(itemId, remoteUser ?? null, body);
  }

  @Post('runtime/deletes/:intentId/retry')
  retryDeleteIntent(
    @Param('intentId') intentId: string,
    @Headers('x-remote-user') remoteUser: string | undefined,
    @Body() body: unknown,
  ) {
    return this.safetyDeskService.retryDeleteIntent(intentId, remoteUser ?? null, body);
  }

  @Post('items/:itemId/approve')
  approveItem(
    @Param('itemId') itemId: string,
    @Headers('x-remote-user') remoteUser: string | undefined,
    @Body() body: unknown,
  ) {
    return this.safetyDeskService.approveItem(itemId, remoteUser ?? null, body);
  }

  @Post('queue/approve-all')
  approveAllReviewItems(
    @Headers('x-remote-user') remoteUser: string | undefined,
    @Body() body: unknown,
  ) {
    return this.safetyDeskService.approveAllReviewItems(remoteUser ?? null, body);
  }

  @Post('items/:itemId/reject')
  rejectItem(
    @Param('itemId') itemId: string,
    @Headers('x-remote-user') remoteUser: string | undefined,
    @Body() body: unknown,
  ) {
    return this.safetyDeskService.rejectItem(itemId, remoteUser ?? null, body);
  }

  @Post('items/:itemId/recheck')
  recheckItem(
    @Param('itemId') itemId: string,
    @Headers('x-remote-user') remoteUser: string | undefined,
  ) {
    return this.safetyDeskService.recheckItem(itemId, remoteUser ?? null);
  }
}
