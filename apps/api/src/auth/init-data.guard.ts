import { CanActivate, ExecutionContext, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { MiniappAccessObservabilityService } from './miniapp-access-observability.service';
import { isMiniappAuthException, MiniappAuthException } from './miniapp-auth.error';
import { InitDataService } from './init-data.service';
import { MINIAPP_CSRF_HEADER_NAME, MINIAPP_SESSION_COOKIE_NAME } from './miniapp-session.constants';
import {
  isMiniappSessionError,
  MiniappCsrfRejectedException,
  MiniappSessionExpiredException,
} from './miniapp-session.error';
import { MiniappRequestSecurityService } from './miniapp-request-security.service';
import { MiniappSessionService } from './miniapp-session.service';
import { isSameMiniappPrincipal, type MiniappAuthContext } from './miniapp-session.types';
import type { AuthUser } from '../common/decorators/current-user.decorator';

type AuthenticatedRequest = FastifyRequest & {
  user?: unknown;
  miniappAuth?: MiniappAuthContext;
};

@Injectable()
export class InitDataGuard implements CanActivate {
  constructor(
    private readonly initDataService: InitDataService,
    @Optional() private readonly accessObservability?: MiniappAccessObservabilityService,
    @Optional() private readonly sessionService?: MiniappSessionService,
    @Optional() private readonly requestSecurity?: MiniappRequestSecurityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authHeader = request.headers.authorization;
    let expiredInitDataError: MiniappAuthException | null = null;
    let expiredInitDataUser: AuthUser | null = null;

    try {
      if (typeof authHeader === 'string' && authHeader) {
        if (!authHeader.startsWith('InitData ')) {
          throw new MiniappAuthException('invalid', 'Invalid authorization scheme');
        }

        const initData = authHeader.slice('InitData '.length);
        try {
          request.user = this.initDataService.validate(initData);
          request.miniappAuth = {
            source: 'init_data',
            principalKey: createHash('sha256').update(initData).digest('hex'),
          };
          return true;
        } catch (error: unknown) {
          if (!isMiniappAuthException(error) || error.kind !== 'expired') {
            throw error;
          }
          expiredInitDataError = error;
          expiredInitDataUser = this.initDataService.validateForSessionRecovery(initData);
        }
      }

      const sessionToken = request.cookies?.[MINIAPP_SESSION_COOKIE_NAME];
      const session = this.sessionService ? await this.sessionService.resolve(sessionToken) : null;
      if (session) {
        if (
          expiredInitDataUser &&
          !isSameMiniappPrincipal(expiredInitDataUser, session.record.user)
        ) {
          throw new MiniappSessionExpiredException('Mini app session identity does not match');
        }
        this.requestSecurity?.assertSessionRequestOrigin(request);
        if (
          this.requiresCsrf(request) &&
          !this.sessionService?.verifyCsrf(
            session,
            this.readHeader(request, MINIAPP_CSRF_HEADER_NAME),
          )
        ) {
          throw new MiniappCsrfRejectedException();
        }

        request.user = expiredInitDataUser ?? session.record.user;
        request.miniappAuth = {
          source: 'session',
          principalKey: session.keyHash,
          session,
        };
        return true;
      }

      if (expiredInitDataError) {
        throw expiredInitDataError;
      }
      if (sessionToken) {
        throw new MiniappSessionExpiredException();
      }
      throw new MiniappAuthException('missing', 'Missing InitData authorization header');
    } catch (error: unknown) {
      if (isMiniappAuthException(error)) {
        this.accessObservability?.recordRejection({
          scope: 'auth',
          code: error.code,
          retryable: error.retryable,
          recovery: error.recovery,
        });
      } else if (isMiniappSessionError(error)) {
        this.accessObservability?.recordRejection({
          scope: 'auth',
          code: error.code,
          retryable: error.retryable,
          recovery: error.recovery,
        });
      }
      throw error;
    }
  }

  private requiresCsrf(request: FastifyRequest): boolean {
    const method = request.method.toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      return true;
    }

    return request.routeOptions?.url === '/api/v1/_mutation-tunnel';
  }

  private readHeader(request: FastifyRequest, name: string): string | undefined {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }
}
