import { Body, Controller, Get, Header, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { MiniappProfiles } from '../auth/miniapp-profile';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { PublisherVideoUploadQueueService } from '../publisher/publisher-video-upload.queue';

@Controller('v1/publications/video-uploads')
@UseGuards(InitDataGuard)
@MiniappProfiles('publisher')
export class PublicationVideoUploadsController {
  constructor(private readonly uploads: PublisherVideoUploadQueueService) {}

  @Post()
  @HttpCode(202)
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.uploads.create(user.userId, body);
  }

  @Get(':uploadId')
  @Header('Cache-Control', 'private, no-store')
  get(@CurrentUser() user: AuthUser, @Param('uploadId') uploadId: string) {
    return this.uploads.status(user.userId, uploadId);
  }

  @Post(':uploadId/complete')
  @HttpCode(202)
  complete(@CurrentUser() user: AuthUser, @Param('uploadId') uploadId: string) {
    return this.uploads.complete(user.userId, uploadId);
  }
}
