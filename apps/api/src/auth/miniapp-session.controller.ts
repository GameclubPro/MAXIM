import { Controller, Delete, Get, Headers, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { InitDataService } from './init-data.service';
import { MINIAPP_CSRF_HEADER_NAME, MINIAPP_SESSION_COOKIE_NAME } from './miniapp-session.constants';
import { MiniappAuthException } from './miniapp-auth.error';
import {
  MiniappCsrfRejectedException,
  MiniappSessionExpiredException,
} from './miniapp-session.error';
import { MiniappRequestSecurityService } from './miniapp-request-security.service';
import { MiniappSessionService } from './miniapp-session.service';
import { isSameMiniappPrincipal, type ResolvedMiniappSession } from './miniapp-session.types';

type SessionResponse = {
  authenticated: true;
  csrfToken: string;
  expiresAt: string;
  expiresInSec: number;
};

@Controller('v1/auth/miniapp-session')
export class MiniappSessionController {
  constructor(
    private readonly initDataService: InitDataService,
    private readonly sessionService: MiniappSessionService,
    private readonly requestSecurity: MiniappRequestSecurityService,
  ) {}

  @Post()
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionResponse> {
    this.requestSecurity.assertSessionRequestOrigin(request);
    const user = this.initDataService.validate(this.readInitDataAuthorization(authorization));
    const previousToken = request.cookies?.[MINIAPP_SESSION_COOKIE_NAME];
    const existing = previousToken ? await this.sessionService.resolve(previousToken) : null;
    if (existing && isSameMiniappPrincipal(user, existing.record.user)) {
      const refreshed = await this.sessionService.refreshUser(existing, user);
      if (refreshed) {
        this.applyNoStore(reply);
        return this.buildSessionResponse(refreshed);
      }
    }

    const created = await this.sessionService.create(user);
    this.setSessionCookie(reply, created.sessionToken, created.expiresAt);
    if (previousToken && previousToken !== created.sessionToken) {
      const cleanup = existing
        ? this.sessionService.destroyResolved(previousToken, existing)
        : this.sessionService.destroy(previousToken);
      void cleanup.catch(() => undefined);
    }

    this.applyNoStore(reply);
    return {
      authenticated: true,
      csrfToken: created.csrfToken,
      expiresAt: new Date(created.expiresAt).toISOString(),
      expiresInSec: this.resolveExpiresInSec(created.expiresAt),
    };
  }

  @Get()
  async recover(
    @Headers('authorization') authorization: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionResponse> {
    this.requestSecurity.assertSessionRequestOrigin(request);
    const user = this.initDataService.validateForSessionRecovery(
      this.readInitDataAuthorization(authorization),
    );
    const token = request.cookies?.[MINIAPP_SESSION_COOKIE_NAME];
    const session = await this.sessionService.resolve(token);
    if (!session) {
      this.clearSessionCookie(reply);
      throw new MiniappSessionExpiredException();
    }
    if (!isSameMiniappPrincipal(user, session.record.user)) {
      this.clearSessionCookie(reply);
      throw new MiniappSessionExpiredException('Mini app session identity does not match');
    }

    this.applyNoStore(reply);
    return this.buildSessionResponse(session);
  }

  @Delete()
  async destroy(
    @Headers(MINIAPP_CSRF_HEADER_NAME) csrfToken: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ authenticated: false }> {
    this.requestSecurity.assertSessionRequestOrigin(request);
    const token = request.cookies?.[MINIAPP_SESSION_COOKIE_NAME];
    const session = await this.sessionService.resolve(token);
    if (!session) {
      this.clearSessionCookie(reply);
      throw new MiniappSessionExpiredException();
    }
    if (!this.sessionService.verifyCsrf(session, csrfToken)) {
      throw new MiniappCsrfRejectedException();
    }

    await this.sessionService.destroyResolved(token, session);
    this.clearSessionCookie(reply);
    this.applyNoStore(reply);
    return { authenticated: false };
  }

  private setSessionCookie(reply: FastifyReply, token: string, expiresAt: number): void {
    reply.setCookie(MINIAPP_SESSION_COOKIE_NAME, token, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      expires: new Date(expiresAt),
    });
  }

  private clearSessionCookie(reply: FastifyReply): void {
    reply.clearCookie(MINIAPP_SESSION_COOKIE_NAME, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
  }

  private applyNoStore(reply: FastifyReply): void {
    reply.header('Cache-Control', 'no-store, private');
    reply.header('Pragma', 'no-cache');
  }

  private readInitDataAuthorization(authorization: string | undefined): string {
    if (!authorization) {
      throw new MiniappAuthException('missing', 'Missing InitData authorization header');
    }
    if (!authorization.startsWith('InitData ')) {
      throw new MiniappAuthException('invalid', 'Invalid authorization scheme');
    }
    return authorization.slice('InitData '.length);
  }

  private buildSessionResponse(session: ResolvedMiniappSession): SessionResponse {
    return {
      authenticated: true,
      csrfToken: session.record.csrfToken,
      expiresAt: new Date(session.record.expiresAt).toISOString(),
      expiresInSec: this.resolveExpiresInSec(session.record.expiresAt),
    };
  }

  private resolveExpiresInSec(expiresAt: number): number {
    return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1_000));
  }
}
