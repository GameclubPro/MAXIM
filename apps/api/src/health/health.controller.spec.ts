import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

describe('HealthController', () => {
  let app: NestFastifyApplication;
  const ready = jest.fn();
  const ocrReady = jest.fn();

  beforeEach(async () => {
    ready.mockReset().mockResolvedValue({ ok: true, scope: 'full' });
    ocrReady.mockReset().mockReturnValue({
      ok: true,
      timestamp: '2026-09-01T10:00:00.000Z',
      scope: 'ocr',
      checks: {
        ocr: {
          state: 'ready',
          ready: true,
          workers: { configured: 1, live: 1, ready: 1, busy: 0 },
          queueDepth: 0,
          behaviorIdentity: {
            complete: true,
            required: true,
            verified: true,
            state: 'verified',
          },
        },
      },
    });
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthService,
          useValue: { ready, ocrReady, live: jest.fn(), botLoad: jest.fn() },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 from the isolated OCR readiness scope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health/ready?scope=ocr',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      scope: 'ocr',
      checks: { ocr: { state: 'ready', ready: true } },
    });
    expect(ocrReady).toHaveBeenCalledTimes(1);
    expect(ready).not.toHaveBeenCalled();
  });

  it('returns 503 with the isolated OCR diagnostics when the runtime is degraded', async () => {
    const degraded = {
      ok: false,
      timestamp: '2026-09-01T10:01:00.000Z',
      scope: 'ocr',
      checks: {
        ocr: {
          state: 'degraded',
          ready: false,
          workers: { configured: 1, live: 1, ready: 0, busy: 1 },
          queueDepth: 2,
          behaviorIdentity: {
            complete: true,
            required: true,
            verified: false,
            state: 'failed',
          },
        },
      },
    };
    ocrReady.mockReturnValue(degraded);

    const response = await app.inject({
      method: 'GET',
      url: '/api/health/ready?scope=ocr',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(degraded);
    expect(ocrReady).toHaveBeenCalledTimes(1);
    expect(ready).not.toHaveBeenCalled();
  });

  it('preserves full readiness without a scope and rejects unsupported scopes', async () => {
    const fullResponse = await app.inject({ method: 'GET', url: '/api/health/ready' });
    const invalidResponse = await app.inject({
      method: 'GET',
      url: '/api/health/ready?scope=unexpected',
    });

    expect(fullResponse.statusCode).toBe(200);
    expect(fullResponse.json()).toEqual({ ok: true, scope: 'full' });
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ocrReady).not.toHaveBeenCalled();
    expect(invalidResponse.statusCode).toBe(400);
  });
});
