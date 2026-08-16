import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import { MiniappOriginRejectedException } from './miniapp-session.error';

function readHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

@Injectable()
export class MiniappRequestSecurityService {
  private readonly allowedOrigin: string;

  constructor(configService: ConfigService) {
    this.allowedOrigin = new URL(configService.getOrThrow<string>('APP_BASE_URL')).origin;
  }

  isCorsOriginAllowed(origin: string | undefined): boolean {
    return !origin || this.isAllowedOrigin(origin);
  }

  assertSessionRequestOrigin(request: FastifyRequest): void {
    const origin = readHeader(request, 'origin')?.trim();
    if (origin) {
      if (!this.isAllowedOrigin(origin)) {
        throw new MiniappOriginRejectedException();
      }
      return;
    }

    const fetchSite = readHeader(request, 'sec-fetch-site')?.trim().toLowerCase();
    if (fetchSite && fetchSite !== 'same-origin') {
      throw new MiniappOriginRejectedException();
    }
  }

  private isAllowedOrigin(origin: string): boolean {
    try {
      return new URL(origin).origin === this.allowedOrigin && origin === new URL(origin).origin;
    } catch {
      return false;
    }
  }
}
