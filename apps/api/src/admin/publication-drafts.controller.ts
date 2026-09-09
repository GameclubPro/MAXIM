import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { MiniappProfiles } from '../auth/miniapp-profile';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { PublicationService } from './publication.service';
import { PublicationDraftsService } from './publication-drafts.service';

@Controller('v1/publications/drafts')
@UseGuards(InitDataGuard)
@MiniappProfiles('publisher')
export class PublicationDraftsController {
  constructor(
    private readonly drafts: PublicationDraftsService,
    private readonly publications: PublicationService,
  ) {}
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    return this.publications.list(user, { ...query, view: 'drafts' }, 'PUBLIK_V1');
  }
  @Post()
  save(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.drafts.save(null, user, body);
  }
  @Get('by-request/:requestId')
  byRequest(@Param('requestId') requestId: string, @CurrentUser() user: AuthUser) {
    return this.drafts.byRequest(requestId, user);
  }
  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.drafts.get(id, user);
  }
  @Put(':id')
  update(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.drafts.save(id, user, body);
  }
  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.drafts.remove(id, user, body);
  }
}
