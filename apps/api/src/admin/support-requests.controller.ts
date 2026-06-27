import { Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { SafetyDeskAdminGuard } from './safety-desk-admin.guard';
import { SupportRequestsService } from './support-requests.service';

@Controller('v1/support-requests')
@UseGuards(SafetyDeskAdminGuard)
export class SupportRequestsController {
  constructor(private readonly supportRequestsService: SupportRequestsService) {}

  @Get('queue')
  getQueue() {
    return this.supportRequestsService.getQueue();
  }

  @Post('items/:itemId/close')
  closeItem(@Param('itemId') itemId: string, @Headers('x-remote-user') remoteUser?: string) {
    return this.supportRequestsService.closeItem(itemId, remoteUser ?? null);
  }
}
