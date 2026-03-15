import {
  type ManagedEntityType,
  type SurfaceEntryRequest,
  surfaceEntryResponseSchema,
  type SurfaceEntryResponse,
  type SurfaceTarget,
} from '@maxim/contracts';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const SURFACE_WORKBENCH_START_PREFIX = 'wb-';
export const SURFACE_SETTINGS_SECTION_START_PREFIX = 'ss-';

type WorkbenchStartPayload = {
  v: 1;
  k: 'workbench';
  e: ManagedEntityType;
  c: string;
  s: string | null;
  screen: string | null;
};

type SettingsSectionStartPayload = {
  v: 1;
  k: 'settings-section';
  e: ManagedEntityType;
  c: string;
  s: string;
};

@Injectable()
export class SurfaceOrchestratorService {
  private readonly appBaseUrl: string | null;
  private readonly botDeepLinkId: string | null;

  constructor(configService: ConfigService) {
    this.appBaseUrl = this.normalizeAppBaseUrl(configService.get<string>('APP_BASE_URL'));
    this.botDeepLinkId = this.normalizeBotDeepLinkId(configService.get<string>('MAX_BOT_ID'));
  }

  resolveEntry(request: SurfaceEntryRequest): SurfaceEntryResponse {
    const targetSurface = this.resolveTargetSurface(request);
    const miniappUrl = this.buildMiniappTargetUrl(request);
    const botUrl = this.buildBotTargetUrl(request);
    const fallbackUrl = targetSurface === 'miniapp' ? miniappUrl : botUrl ?? miniappUrl;

    return surfaceEntryResponseSchema.parse({
      targetSurface,
      botUrl,
      miniappUrl,
      startParam:
        targetSurface === 'miniapp'
          ? this.buildMiniappStartParam(request)
          : this.buildBotStartParam(request),
      resumeToken: null,
      fallbackUrl: fallbackUrl ?? miniappUrl ?? botUrl ?? 'https://max.ru',
    });
  }

  buildMiniappStartParam(request: Pick<SurfaceEntryRequest, 'entityType' | 'entityId' | 'section'>) {
    if (request.section?.trim()) {
      return this.buildSettingsSectionStartParam({
        entityType: request.entityType,
        entityId: request.entityId,
        section: request.section.trim(),
      });
    }

    return this.buildWorkbenchStartParam({
      entityType: request.entityType,
      entityId: request.entityId,
      section: null,
      screen: null,
    });
  }

  buildWorkbenchStartParam(params: {
    entityType: ManagedEntityType;
    entityId: string;
    section?: string | null;
    screen?: string | null;
  }): string {
    const encoded = Buffer.from(
      JSON.stringify({
        v: 1,
        k: 'workbench',
        e: params.entityType,
        c: params.entityId,
        s: params.section?.trim() || null,
        screen: params.screen?.trim() || null,
      } satisfies WorkbenchStartPayload),
      'utf8',
    ).toString('base64url');

    return `${SURFACE_WORKBENCH_START_PREFIX}${encoded}`;
  }

  buildSettingsSectionStartParam(params: {
    entityType: ManagedEntityType;
    entityId: string;
    section: string;
  }): string {
    const encoded = Buffer.from(
      JSON.stringify({
        v: 1,
        k: 'settings-section',
        e: params.entityType,
        c: params.entityId,
        s: params.section.trim(),
      } satisfies SettingsSectionStartPayload),
      'utf8',
    ).toString('base64url');

    return `${SURFACE_SETTINGS_SECTION_START_PREFIX}${encoded}`;
  }

  buildMiniappDirectUrl(params: {
    entityType: ManagedEntityType;
    entityId: string;
    section?: string | null;
  }): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    const basePath =
      params.section?.trim()
        ? `/app/${params.entityType}/${encodeURIComponent(params.entityId)}/settings`
        : `/app/${params.entityType}/${encodeURIComponent(params.entityId)}`;

    const query = params.section?.trim()
      ? `?section=${encodeURIComponent(params.section.trim())}`
      : '';

    return `${this.appBaseUrl}${basePath}${query}`;
  }

  buildMiniappStartUrl(startParam: string): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    return `${this.appBaseUrl}/app/?startapp=${encodeURIComponent(startParam)}`;
  }

  buildBotStartUrl(startPayload: string): string | null {
    if (!this.botDeepLinkId) {
      return null;
    }

    return `https://max.ru/${encodeURIComponent(this.botDeepLinkId)}?start=${encodeURIComponent(startPayload)}`;
  }

  private buildMiniappTargetUrl(request: SurfaceEntryRequest): string | null {
    const directSection = this.resolveMiniappSection(request);
    const startParam = directSection
      ? this.buildSettingsSectionStartParam({
          entityType: request.entityType,
          entityId: request.entityId,
          section: directSection,
        })
      : this.buildWorkbenchStartParam({
          entityType: request.entityType,
          entityId: request.entityId,
          section: null,
          screen: null,
        });

    return this.buildMiniappStartUrl(startParam) ??
      this.buildMiniappDirectUrl({
        entityType: request.entityType,
        entityId: request.entityId,
        section: directSection,
      });
  }

  private buildBotTargetUrl(request: SurfaceEntryRequest): string | null {
    const startPayload = this.buildBotStartParam(request);
    if (!startPayload) {
      return null;
    }

    return this.buildBotStartUrl(startPayload);
  }

  private buildBotStartParam(request: SurfaceEntryRequest): string | null {
    const screen = this.resolvePrivateScreen(request);
    if (!screen) {
      return null;
    }

    return this.buildWorkbenchStartParam({
      entityType: request.entityType,
      entityId: request.entityId,
      section: request.section ?? null,
      screen,
    });
  }

  private resolveTargetSurface(request: SurfaceEntryRequest): SurfaceTarget {
    if (
      request.intent === 'events' ||
      request.intent === 'manual_action' ||
      request.intent === 'broadcast_confirm'
    ) {
      return 'private_bot';
    }

    if (request.sourceSurface === 'legacy_handoff' && request.intent === 'giveaway_manage') {
      return 'private_bot';
    }

    return 'miniapp';
  }

  private resolvePrivateScreen(request: SurfaceEntryRequest): string | null {
    if (request.intent === 'events') {
      return 'events';
    }
    if (request.intent === 'manual_action') {
      return 'manual_users';
    }
    if (request.intent === 'broadcast_confirm') {
      return 'broadcast';
    }
    if (request.sourceSurface === 'legacy_handoff' && request.intent === 'giveaway_manage') {
      return 'giveaway';
    }

    return null;
  }

  private resolveMiniappSection(request: SurfaceEntryRequest): string | null {
    if (request.intent === 'settings_section') {
      return request.section?.trim() || null;
    }
    if (request.intent === 'broadcast_compose') {
      return request.entityType === 'channel' ? 'broadcast' : 'mailing';
    }
    if (request.intent === 'poll_manage') {
      return 'poll';
    }
    if (request.intent === 'giveaway_manage') {
      return 'giveaway';
    }
    if (request.intent === 'channel_dialog') {
      return request.dialogType === 'suggest' ? 'postSuggestions' : 'comments';
    }

    return null;
  }

  private normalizeAppBaseUrl(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().replace(/\/+$/u, '');
    if (!normalized || !/^https?:\/\//iu.test(normalized)) {
      return null;
    }

    return normalized;
  }

  private normalizeBotDeepLinkId(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }
}
