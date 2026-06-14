import {
  BadRequestException,
  Controller,
  GatewayTimeoutException,
  Get,
  Headers,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { gunzipSync } from 'node:zlib';
import { InitDataGuard } from '../auth/init-data.guard';

const ALLOWED_TUNNEL_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_TUNNEL_BODY_LENGTH = 128 * 1024;
const TUNNEL_TIMEOUT_MS = 25_000;

type TunnelRouteRule = {
  method: string;
  pattern: RegExp;
};

const ENTITY_ID_SEGMENT = '[^/?#]+';
const DIALOG_TYPE_SEGMENT = '[^/?#]+';

const ALLOWED_TUNNEL_ROUTES: readonly TunnelRouteRule[] = [
  {
    method: 'POST',
    pattern: new RegExp(
      `^/chats/${ENTITY_ID_SEGMENT}/bots/(primary|partner-assist|promote-standby)$`,
    ),
  },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/channels/${ENTITY_ID_SEGMENT}/bots/(primary|partner-assist|promote-standby)$`,
    ),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/managed-entities/(chat|channel)/${ENTITY_ID_SEGMENT}/access/recheck$`),
  },
  {
    method: 'PUT',
    pattern: new RegExp(`^/managed-entities/(chat|channel)/${ENTITY_ID_SEGMENT}/favorites$`),
  },

  {
    method: 'POST',
    pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/required-subscription/channels/resolve$`),
  },
  { method: 'PUT', pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/settings$`) },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/chats/${ENTITY_ID_SEGMENT}/settings/apply-(section-to-all|section-preview|to-all)$`,
    ),
  },
  { method: 'PUT', pattern: new RegExp(`^/channels/${ENTITY_ID_SEGMENT}/settings$`) },
  { method: 'PUT', pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/rules$`) },
  { method: 'POST', pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/rules/(publish|handoff)$`) },
  { method: 'DELETE', pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/rules/publish$`) },
  { method: 'PUT', pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/poll$`) },
  {
    method: 'POST',
    pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/poll/(publish|close)$`),
  },
  { method: 'POST', pattern: new RegExp(`^/channels/${ENTITY_ID_SEGMENT}/engagement-publish$`) },

  { method: 'POST', pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/domain-allowlist$`) },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/domain-allowlist(/${ENTITY_ID_SEGMENT})?$`),
  },
  {
    method: 'PUT',
    pattern: new RegExp(
      `^/chats/${ENTITY_ID_SEGMENT}/domain-allowlist(/${ENTITY_ID_SEGMENT})?/removal-schedule$`,
    ),
  },

  {
    method: 'POST',
    pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/broadcast(/test|/handoff)?$`),
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/broadcast/handoff$`),
  },
  {
    method: 'PUT',
    pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/broadcasts/${ENTITY_ID_SEGMENT}$`),
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/broadcasts/${ENTITY_ID_SEGMENT}$`),
  },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/broadcasts/${ENTITY_ID_SEGMENT}/retry$`,
    ),
  },

  { method: 'POST', pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/giveaways$`) },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/giveaways/required-channels/resolve$`,
    ),
  },
  {
    method: 'PUT',
    pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/giveaways/${ENTITY_ID_SEGMENT}$`),
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/giveaways/${ENTITY_ID_SEGMENT}$`),
  },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/giveaways/${ENTITY_ID_SEGMENT}/(publish|close|reroll|deliver|cancel)$`,
    ),
  },
  { method: 'POST', pattern: new RegExp(`^/giveaways/${ENTITY_ID_SEGMENT}/(enter|claim)$`) },
  {
    method: 'POST',
    pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/giveaway/handoff$`),
  },

  {
    method: 'POST',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/dialog/${DIALOG_TYPE_SEGMENT}/messages$`,
    ),
  },
  {
    method: 'PUT',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/dialog/${DIALOG_TYPE_SEGMENT}/notifications$`,
    ),
  },
  {
    method: 'PATCH',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/dialog/${DIALOG_TYPE_SEGMENT}/messages/${ENTITY_ID_SEGMENT}$`,
    ),
  },
  {
    method: 'DELETE',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/dialog/${DIALOG_TYPE_SEGMENT}/messages/${ENTITY_ID_SEGMENT}$`,
    ),
  },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/dialog/${DIALOG_TYPE_SEGMENT}/messages/${ENTITY_ID_SEGMENT}/reactions$`,
    ),
  },

  {
    method: 'PATCH',
    pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/vk-parsing/settings$`),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/vk-parsing/(rollback|refresh)$`),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/vk-parsing/sources(/bulk)?$`),
  },
  {
    method: 'PATCH',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/vk-parsing/sources/${ENTITY_ID_SEGMENT}$`,
    ),
  },
  {
    method: 'DELETE',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/vk-parsing/sources/${ENTITY_ID_SEGMENT}$`,
    ),
  },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/vk-parsing/sources/${ENTITY_ID_SEGMENT}/refresh$`,
    ),
  },
  {
    method: 'PATCH',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/vk-parsing/posts/${ENTITY_ID_SEGMENT}/schedule$`,
    ),
  },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/vk-parsing/posts/${ENTITY_ID_SEGMENT}/(retry|cancel|publish|publish-now)$`,
    ),
  },

  {
    method: 'PUT',
    pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/members/${ENTITY_ID_SEGMENT}/immunity$`),
  },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/chats/${ENTITY_ID_SEGMENT}/members/${ENTITY_ID_SEGMENT}/(moderation-action|profile/handoff)$`,
    ),
  },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/channels/${ENTITY_ID_SEGMENT}/members/${ENTITY_ID_SEGMENT}/profile/handoff$`,
    ),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/spammer-review/${ENTITY_ID_SEGMENT}$`),
  },
  { method: 'POST', pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/admin-allowlist$`) },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/admin-allowlist/${ENTITY_ID_SEGMENT}$`),
  },
];

type MutationTunnelQuery = {
  method?: string;
  path?: string;
  body?: string;
  bodyGzip?: string;
  contentType?: string;
  nonce?: string;
};

@Controller('v1')
@UseGuards(InitDataGuard)
export class MiniappMutationTunnelController {
  @Get('_mutation-tunnel')
  async tunnel(
    @Query() query: MutationTunnelQuery,
    @Headers('authorization') authorization: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const method = this.normalizeMethod(query.method);
    const target = this.normalizePath(query.path, method);
    const body = this.decodeBody(query.body, query.bodyGzip);
    const contentType = this.normalizeContentType(query.contentType, body);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TUNNEL_TIMEOUT_MS);

    try {
      const response = await fetch(this.buildInternalUrl(target), {
        method,
        body,
        signal: controller.signal,
        headers: {
          Authorization: authorization ?? '',
          ...(contentType ? { 'Content-Type': contentType } : {}),
          'X-Miniapp-Mutation-Tunnel': '1',
        },
      });

      const responseContentType = response.headers.get('content-type');
      if (responseContentType) {
        reply.header('Content-Type', responseContentType);
      }
      reply.header('Cache-Control', 'no-store, private');
      reply.header('Pragma', 'no-cache');
      reply.header('Vary', 'Authorization');

      const payload = await response.text();
      reply.status(response.status);
      if (response.status === 204 || response.status === 205 || !payload) {
        reply.send();
        return;
      }

      reply.send(payload);
    } catch (error: unknown) {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new GatewayTimeoutException('Mutation tunnel timed out');
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private normalizeMethod(value: string | undefined): string {
    const method = (value ?? '').trim().toUpperCase();
    if (!ALLOWED_TUNNEL_METHODS.has(method)) {
      throw new BadRequestException('Unsupported tunnel method');
    }

    return method;
  }

  private normalizePath(value: string | undefined, method: string): string {
    const rawPath = (value ?? '').trim();
    if (!rawPath || !rawPath.startsWith('/') || rawPath.startsWith('//')) {
      throw new BadRequestException('Invalid tunnel path');
    }

    const parsed = new URL(rawPath, 'http://miniapp-tunnel.local');
    if (parsed.origin !== 'http://miniapp-tunnel.local') {
      throw new BadRequestException('Invalid tunnel path');
    }

    if (
      parsed.pathname === '/_mutation-tunnel' ||
      parsed.pathname.startsWith('/_mutation-tunnel/')
    ) {
      throw new BadRequestException('Invalid tunnel target');
    }

    const normalized = `${parsed.pathname}${parsed.search}`;
    if (!this.isAllowedTunnelTarget(normalized, method)) {
      throw new BadRequestException('Unsupported tunnel target');
    }

    return normalized;
  }

  private decodeBody(
    value: string | undefined,
    gzipValue: string | undefined,
  ): string | undefined {
    if (value && gzipValue) {
      throw new BadRequestException('Ambiguous tunnel body');
    }

    if (!value && !gzipValue) {
      return undefined;
    }

    const encodedValue = value ?? gzipValue;
    if (!encodedValue) {
      return undefined;
    }

    if (encodedValue.length > MAX_TUNNEL_BODY_LENGTH) {
      throw new BadRequestException('Tunnel body is too large');
    }

    const decoded = this.decodeBase64Url(encodedValue);
    const body = gzipValue ? this.gunzipBody(decoded) : decoded.toString('utf8');
    if (body.length > MAX_TUNNEL_BODY_LENGTH) {
      throw new BadRequestException('Tunnel body is too large');
    }

    return body;
  }

  private decodeBase64Url(value: string): Buffer {
    if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
      throw new BadRequestException('Invalid tunnel body');
    }

    const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
    return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }

  private gunzipBody(value: Buffer): string {
    try {
      return gunzipSync(value).toString('utf8');
    } catch {
      throw new BadRequestException('Invalid tunnel body');
    }
  }

  private normalizeContentType(
    value: string | undefined,
    body: string | undefined,
  ): string | undefined {
    const contentType = (value ?? '').trim();
    if (contentType) {
      return contentType;
    }

    return body === undefined ? undefined : 'application/json';
  }

  private buildInternalUrl(target: string): string {
    const port = Number(process.env.PORT ?? 3001);
    return `http://127.0.0.1:${port}/api/v1${target}`;
  }

  private isAllowedTunnelTarget(target: string, method: string): boolean {
    const parsed = new URL(target, 'http://miniapp-tunnel.local');
    const pathname = parsed.pathname;
    return ALLOWED_TUNNEL_ROUTES.some(
      (rule) => rule.method === method && rule.pattern.test(pathname),
    );
  }
}
