import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AdminService } from './admin.service';

@Controller('v1/public/dialog-browser-handoff')
export class DialogBrowserHandoffController {
  constructor(private readonly adminService: AdminService) {}

  @Get(':handoffId')
  getDialogBrowserHandoffSession(@Param('handoffId') handoffId: string) {
    return this.adminService.getDialogBrowserHandoffSession(handoffId);
  }

  @Post(':handoffId/messages')
  submitDialogBrowserHandoffMessage(@Param('handoffId') handoffId: string, @Body() body: unknown) {
    return this.adminService.submitDialogBrowserHandoffMessage(handoffId, body);
  }
}
