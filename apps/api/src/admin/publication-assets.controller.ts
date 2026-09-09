import { Controller, Get, Param, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { InitDataGuard } from '../auth/init-data.guard';
import { MiniappProfiles } from '../auth/miniapp-profile';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { PublicationContentService } from './publication-content.service';

@Controller('v1/publications/:publicationId/assets')
@UseGuards(InitDataGuard)
@MiniappProfiles('publisher')
export class PublicationAssetsController {
  constructor(private readonly content: PublicationContentService) {}
  @Get(':assetId')
  async get(
    @Param('publicationId') publicationId: string,
    @Param('assetId') assetId: string,
    @CurrentUser() user: AuthUser,
    @Res() reply: FastifyReply,
  ) {
    const asset = await this.content.getOwnedAsset(publicationId, assetId, user.userId);
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    reply.type(asset.mimeType).send(asset.bytes);
  }
}
