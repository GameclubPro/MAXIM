import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class SafetyDeskAdminGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const host = this.readHeader(request.headers.host);

    if (host && this.isAllowedHost(host)) {
      return true;
    }

    throw new ForbiddenException('Safety Desk доступен только через закрытый admin-хост.');
  }

  private isAllowedHost(value: string): boolean {
    const hostname = value.split(',')[0]?.trim().split(':')[0]?.toLowerCase() ?? '';
    const configuredHosts = this.configService.get<string>('SAFETY_DESK_ALLOWED_HOSTS');
    const allowedHosts = new Set(
      (configuredHosts?.trim() ? configuredHosts : 'admin.major-maksimov.ru,localhost,127.0.0.1')
        .split(',')
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    );

    if (allowedHosts.has(hostname)) {
      return true;
    }

    if (this.configService.get<string>('NODE_ENV') !== 'production') {
      return hostname === '0.0.0.0' || hostname === '::1';
    }

    return false;
  }

  private readHeader(value: string | string[] | undefined): string | null {
    if (Array.isArray(value)) {
      return value[0] ?? null;
    }

    return value ?? null;
  }
}
