import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';

@Injectable()
export class MarketplaceIntegrationGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext): boolean {
    const token = this.config.get<string>('SVYAZKA_ANALYTICS_TOKEN');
    if (!token) throw new ServiceUnavailableException('Интеграция не подключена');
    const header = context.switchToHttp().getRequest<{ headers: { authorization?: string } }>()
      .headers.authorization;
    const actual =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    const digest = (value: string) => createHash('sha256').update(value).digest();
    if (!actual || !timingSafeEqual(digest(actual), digest(token)))
      throw new UnauthorizedException();
    return true;
  }
}
