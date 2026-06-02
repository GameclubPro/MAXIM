import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { MiniappBootTraceController } from './miniapp-boot-trace.controller';
import { MiniappBootTraceService } from './miniapp-boot-trace.service';

describe('MiniappBootTraceController', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MiniappBootTraceController],
      providers: [MiniappBootTraceService],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('accepts an unauthenticated boot trace event', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/system/miniapp-boot-trace',
      payload: {
        phase: 'start',
        sessionId: 'session-1',
        route: '/app/',
        elapsedMs: 0,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('rejects invalid boot trace payloads', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/system/miniapp-boot-trace',
      payload: {
        elapsedMs: 1,
      },
    });

    expect(response.statusCode).toBe(400);
  });
});
