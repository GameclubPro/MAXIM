import { broadcastHandoffResponseSchema } from '@maxim/contracts';
import { SurfaceOrchestratorService } from './surface-orchestrator.service';

function createConfigMock() {
  return {
    get: jest.fn((key: string) => {
      if (key === 'APP_BASE_URL') {
        return 'https://maxim.play-team.ru';
      }
      if (key === 'MAX_BOT_ID') {
        return '777000_bot';
      }
      return null;
    }),
  };
}

function decodeStartPayload<T>(payload: string): T {
  return JSON.parse(Buffer.from(payload.slice(3), 'base64url').toString('utf8')) as T;
}

describe('SurfaceOrchestratorService', () => {
  it('routes settings section intents to miniapp with ss payload', () => {
    const service = new SurfaceOrchestratorService(createConfigMock() as never);

    const result = service.resolveEntry({
      intent: 'settings_section',
      entityType: 'chat',
      entityId: 'chat-1',
      section: 'links',
      dialogType: null,
      resourceId: null,
      sourceSurface: 'miniapp',
    });

    expect(result.targetSurface).toBe('miniapp');
    expect(result.startParam).toMatch(/^ss-/u);
    expect(result.miniappUrl).toContain('startapp=ss-');
    expect(decodeStartPayload<{ v: number; k: string; e: string; c: string; s: string }>(result.startParam ?? '')).toEqual({
      v: 1,
      k: 'settings-section',
      e: 'chat',
      c: 'chat-1',
      s: 'links',
    });
  });

  it('routes quick operational intents to private bot with wb payload', () => {
    const service = new SurfaceOrchestratorService(createConfigMock() as never);

    const result = service.resolveEntry({
      intent: 'events',
      entityType: 'chat',
      entityId: 'chat-1',
      section: null,
      dialogType: null,
      resourceId: null,
      sourceSurface: 'miniapp',
    });

    expect(result.targetSurface).toBe('private_bot');
    expect(result.startParam).toMatch(/^wb-/u);
    expect(result.botUrl).toContain('start=wb-');
    expect(decodeStartPayload<{ v: number; k: string; e: string; c: string; screen: string | null }>(result.startParam ?? '')).toEqual({
      v: 1,
      k: 'workbench',
      e: 'chat',
      c: 'chat-1',
      s: null,
      screen: 'events',
    });
  });

  it('keeps legacy handoff response backward compatible', () => {
    expect(
      broadcastHandoffResponseSchema.parse({
        botUrl: 'https://max.ru/777000_bot?start=broadcast_handoff',
      }),
    ).toEqual({
      botUrl: 'https://max.ru/777000_bot?start=broadcast_handoff',
      targetSurface: 'private_bot',
      miniappUrl: null,
      startParam: null,
      resumeToken: null,
      fallbackUrl: null,
    });
  });
});
