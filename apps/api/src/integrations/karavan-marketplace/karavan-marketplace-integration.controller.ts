import { KaravanMarketplaceResolverService } from './karavan-marketplace-resolver.service';
import {
  KaravanMarketplaceBindingStatusService,
  karavanMarketplaceBindingStatusRequestSchema,
} from './karavan-marketplace-binding-status.service';
import { KaravanMarketplaceActorAccessService } from './karavan-marketplace-actor-access.service';
import {
  BadRequestException,
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  HttpCode,
  Injectable,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  karavanPublicationChoiceListRequestSchema,
  karavanPublicationChoiceSaveSchema,
  karavanMarketplaceAuthorityRequestSchema,
  karavanMarketplaceActorAccessRequestSchema,
  karavanMarketplaceHandoffExchangeSchema,
} from '@maxim/contracts/karavan-marketplace';
import { KaravanMarketplaceAuthorityService } from './karavan-marketplace-authority.service';
import { KaravanMarketplaceHandoffService } from './karavan-marketplace-handoff.service';

function parseRequest<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException('Некорректный запрос.');
  return result.data;
}

@Injectable()
export class KaravanMarketplaceIntegrationGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('KARAVAN_MARKETPLACE_AUTHORITY_TOKEN');
    const supplied = context.switchToHttp().getRequest<FastifyRequest>().headers.authorization;
    if (
      !expected ||
      !supplied?.startsWith('Bearer ') ||
      !timingSafeEqual(
        createHash('sha256').update(expected).digest(),
        createHash('sha256').update(supplied.slice(7)).digest(),
      )
    )
      throw new UnauthorizedException();
    return true;
  }
}

@Controller('v1/integrations/karavan/v1')
@UseGuards(KaravanMarketplaceIntegrationGuard)
export class KaravanMarketplaceIntegrationController {
  constructor(
    private readonly authority: KaravanMarketplaceAuthorityService,
    private readonly handoffs: KaravanMarketplaceHandoffService,
    private readonly resolver: KaravanMarketplaceResolverService,
    private readonly bindings: KaravanMarketplaceBindingStatusService,
    private readonly actorAccess: KaravanMarketplaceActorAccessService,
  ) {}
  @Post('publication-choices/list')
  choices(@Body() body: unknown) {
    return this.resolver.listChoices(parseRequest(karavanPublicationChoiceListRequestSchema, body));
  }

  @Post('publication-choices/save')
  saveChoice(@Body() body: unknown) {
    return this.resolver.saveChoice(parseRequest(karavanPublicationChoiceSaveSchema, body));
  }

  @Post('bindings/status')
  status(@Body() body: unknown) {
    return this.bindings.status(parseRequest(karavanMarketplaceBindingStatusRequestSchema, body));
  }

  @Post('authority/introspect')
  introspect(@Body() body: unknown) {
    return this.authority.introspect(parseRequest(karavanMarketplaceAuthorityRequestSchema, body));
  }
  @Post('authority/access-check')
  @HttpCode(200)
  accessCheck(@Body() body: unknown) {
    return this.actorAccess.check(parseRequest(karavanMarketplaceActorAccessRequestSchema, body));
  }
  @Post('handoffs/exchange')
  exchange(@Body() body: unknown) {
    return this.handoffs.exchange(parseRequest(karavanMarketplaceHandoffExchangeSchema, body));
  }
}
