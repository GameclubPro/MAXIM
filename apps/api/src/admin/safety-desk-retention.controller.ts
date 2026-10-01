import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { SafetyDeskAdminGuard } from './safety-desk-admin.guard';
import { SafetyDeskRetentionService } from './safety-desk-retention.service';

@Controller('v1/safety-desk/runtime/retention')
@UseGuards(SafetyDeskAdminGuard)
export class SafetyDeskRetentionController {
  constructor(private readonly retention: SafetyDeskRetentionService) {}

  @Get()
  runtime(@Query('after') after?: unknown) {
    return this.retention.runtime(after);
  }

  @Get(':chatId/preview')
  preview(@Param('chatId') chatId: string) {
    return this.retention.preview(chatId);
  }

  @Post(':chatId/retry')
  retry(
    @Param('chatId') chatId: string,
    @Headers('x-remote-user') remoteUser: string | undefined,
    @Body() body: unknown,
  ) {
    return this.retention.retry(chatId, remoteUser ?? null, body);
  }
}
