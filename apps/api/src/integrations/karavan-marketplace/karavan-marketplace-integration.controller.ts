import { KaravanMarketplaceResolverService } from './karavan-marketplace-resolver.service';
import { KaravanMarketplaceBindingStatusService } from './karavan-marketplace-binding-status.service';
import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Injectable,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { KaravanMarketplaceAuthorityService } from './karavan-marketplace-authority.service';
import { KaravanMarketplaceHandoffService } from './karavan-marketplace-handoff.service';

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
  ) {}
  @Post('publication-choices/list')
  choices(@Body() body: unknown) {
    return this.resolver.listChoices(body);
  }

  @Post('publication-choices/save')
  saveChoice(@Body() body: unknown) {
    return this.resolver.saveChoice(body);
  }

  @Post('bindings/status')
  status(@Body() body: unknown) {
    return this.bindings.status(body);
  }

  @Post('authority/introspect')
  introspect(@Body() body: unknown) {
    return this.authority.introspect(body);
  }
  @Post('handoffs/exchange')
  exchange(@Body() body: unknown) {
    return this.handoffs.exchange(body);
  }
}
