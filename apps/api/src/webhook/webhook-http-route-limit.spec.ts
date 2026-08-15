import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import Fastify from 'fastify';
import { request as httpRequest } from 'node:http';

import { SanitizedExceptionFilter } from '../common/sanitized-exception.filter';
import {
  applyMaxWebhookAckDeadline,
  applyMaxWebhookBodyLimit,
  applyMaxWebhookHandlerTimeout,
  DEFAULT_MAX_WEBHOOK_ACK_DEADLINE_MS,
  DEFAULT_MAX_WEBHOOK_BODY_LIMIT_BYTES,
  MAX_MAX_WEBHOOK_ACK_DEADLINE_MS,
  MAX_MAX_WEBHOOK_BODY_LIMIT_BYTES,
  MAX_WEBHOOK_ACK_RESPONSE_GRACE_MS,
  MAX_WEBHOOK_ROUTE_CONFIG_KEY,
  normalizeMaxWebhookAckDeadlineMs,
  normalizeMaxWebhookBodyLimit,
  readMaxWebhookAckDeadlineAtMs,
  registerMaxWebhookHttpRouteLimits,
  resolveMaxWebhookAckWorkDeadlineMs,
} from './webhook-http-route-limit';
import { WebhookIngestionService } from './webhook-ingestion.service';
import { WebhookController } from './webhook.controller';

describe('MAX webhook route body limit', () => {
  it('applies the bounded limit only to marked webhook routes', () => {
    const webhookRoute = {
      config: { [MAX_WEBHOOK_ROUTE_CONFIG_KEY]: true },
      bodyLimit: 32 * 1024 * 1024,
    };
    const otherRoute = { config: {}, bodyLimit: 32 * 1024 * 1024 };

    applyMaxWebhookBodyLimit(webhookRoute, 512 * 1024);
    applyMaxWebhookBodyLimit(otherRoute, 512 * 1024);

    expect(webhookRoute.bodyLimit).toBe(512 * 1024);
    expect(otherRoute.bodyLimit).toBe(32 * 1024 * 1024);
  });

  it('uses the safe default for invalid configuration', () => {
    expect(normalizeMaxWebhookBodyLimit('invalid')).toBe(DEFAULT_MAX_WEBHOOK_BODY_LIMIT_BYTES);
    expect(normalizeMaxWebhookBodyLimit(0)).toBe(DEFAULT_MAX_WEBHOOK_BODY_LIMIT_BYTES);
    expect(normalizeMaxWebhookBodyLimit(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_MAX_WEBHOOK_BODY_LIMIT_BYTES,
    );
  });
});

describe('MAX webhook ACK deadline', () => {
  it('applies a bounded full-lifecycle timeout only to marked webhook routes', () => {
    const webhookRoute = {
      config: { [MAX_WEBHOOK_ROUTE_CONFIG_KEY]: true },
      handlerTimeout: 60_000,
    };
    const otherRoute = { config: {}, handlerTimeout: 60_000 };

    applyMaxWebhookHandlerTimeout(webhookRoute, 5_000);
    applyMaxWebhookHandlerTimeout(otherRoute, 5_000);

    expect(webhookRoute.handlerTimeout).toBe(5_000);
    expect(otherRoute.handlerTimeout).toBe(60_000);
  });

  it('starts during Fastify onRequest before body parsing', async () => {
    const fastify = Fastify();
    const phases: string[] = [];
    fastify.addHook('onRequest', (request, _reply, done) => {
      phases.push('onRequest');
      applyMaxWebhookAckDeadline(request, 5_000, 10_000);
      done();
    });
    fastify.addContentTypeParser(
      'application/x-maxim-webhook',
      { parseAs: 'string' },
      (request, _body, done) => {
        phases.push('bodyParser');
        expect(readMaxWebhookAckDeadlineAtMs(request)).toBe(15_000);
        done(null, {});
      },
    );
    fastify.post(
      '/webhook',
      { config: { [MAX_WEBHOOK_ROUTE_CONFIG_KEY]: true } },
      async (request) => {
        phases.push('handler');
        return { deadlineAtMs: readMaxWebhookAckDeadlineAtMs(request) };
      },
    );

    try {
      const response = await fastify.inject({
        method: 'POST',
        url: '/webhook',
        headers: { 'content-type': 'application/x-maxim-webhook' },
        payload: '{}',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ deadlineAtMs: 15_000 });
      expect(phases).toEqual(['onRequest', 'bodyParser', 'handler']);
    } finally {
      await fastify.close();
    }
  });

  it('records one absolute deadline only for marked webhook routes', () => {
    const webhookRequest = {
      routeOptions: { config: { [MAX_WEBHOOK_ROUTE_CONFIG_KEY]: true } },
    };
    const otherRequest = { routeOptions: { config: {} } };

    applyMaxWebhookAckDeadline(webhookRequest, 5_000, 10_000);
    applyMaxWebhookAckDeadline(otherRequest, 5_000, 10_000);

    expect(readMaxWebhookAckDeadlineAtMs(webhookRequest)).toBe(15_000);
    expect(readMaxWebhookAckDeadlineAtMs(webhookRequest)).toBe(15_000);
    expect(readMaxWebhookAckDeadlineAtMs(otherRequest)).toBeNull();
  });

  it('uses the safe default and caps oversized deadlines', () => {
    expect(normalizeMaxWebhookAckDeadlineMs('invalid')).toBe(DEFAULT_MAX_WEBHOOK_ACK_DEADLINE_MS);
    expect(normalizeMaxWebhookAckDeadlineMs(0)).toBe(DEFAULT_MAX_WEBHOOK_ACK_DEADLINE_MS);
    expect(normalizeMaxWebhookAckDeadlineMs(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_MAX_WEBHOOK_ACK_DEADLINE_MS,
    );
    expect(resolveMaxWebhookAckWorkDeadlineMs(MAX_MAX_WEBHOOK_ACK_DEADLINE_MS)).toBe(
      MAX_MAX_WEBHOOK_ACK_DEADLINE_MS - MAX_WEBHOOK_ACK_RESPONSE_GRACE_MS,
    );
    expect(resolveMaxWebhookAckWorkDeadlineMs(1_000)).toBe(750);
  });

  it('times out an incomplete slow body before parsing or the handler can finish', async () => {
    const fastify = Fastify();
    let handlerCalled = false;
    const recordRouteOutcome = jest.fn();
    registerMaxWebhookHttpRouteLimits(fastify, {
      bodyLimit: DEFAULT_MAX_WEBHOOK_BODY_LIMIT_BYTES,
      ackDeadlineMs: 100,
      recordRouteOutcome,
    });
    fastify.post('/webhook', { config: { [MAX_WEBHOOK_ROUTE_CONFIG_KEY]: true } }, async () => {
      handlerCalled = true;
      return { ok: true };
    });

    try {
      await fastify.listen({ host: '127.0.0.1', port: 0 });
      const address = fastify.server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Fastify did not expose a TCP test address');
      }

      const response = await new Promise<{ statusCode: number | undefined; body: string }>(
        (resolve, reject) => {
          let settled = false;
          const request = httpRequest(
            {
              host: '127.0.0.1',
              port: address.port,
              method: 'POST',
              path: '/webhook',
              headers: {
                'content-length': '64',
                'content-type': 'application/json',
              },
            },
            (incoming) => {
              let body = '';
              incoming.setEncoding('utf8');
              incoming.on('data', (chunk) => {
                body += chunk;
              });
              incoming.on('end', () => {
                settled = true;
                if (watchdog) {
                  clearTimeout(watchdog);
                }
                request.destroy();
                resolve({ statusCode: incoming.statusCode, body });
              });
              incoming.on('error', (error) => {
                if (!settled) {
                  settled = true;
                  if (watchdog) {
                    clearTimeout(watchdog);
                  }
                  reject(error);
                }
              });
            },
          );
          request.on('error', (error) => {
            if (!settled) {
              settled = true;
              if (watchdog) {
                clearTimeout(watchdog);
              }
              reject(error);
            }
          });
          const watchdog = setTimeout(() => {
            if (!settled) {
              settled = true;
              request.destroy();
              reject(new Error('Timed out waiting for the slow-body webhook deadline response'));
            }
          }, 2_000);
          if (settled) {
            clearTimeout(watchdog);
          }
          request.write('{');
        },
      );

      expect(response.statusCode).toBe(503);
      expect(response.body).toContain('FST_ERR_HANDLER_TIMEOUT');
      expect(handlerCalled).toBe(false);
      expect(recordRouteOutcome).toHaveBeenCalledWith({
        botId: null,
        outcome: 'timed_out',
      });
    } finally {
      await fastify.close();
    }
  });

  it('keeps a late handler result from replacing the timeout response', async () => {
    const fastify = Fastify();
    let handlerSettled = false;
    registerMaxWebhookHttpRouteLimits(fastify, {
      bodyLimit: DEFAULT_MAX_WEBHOOK_BODY_LIMIT_BYTES,
      ackDeadlineMs: 50,
    });
    fastify.post('/webhook', { config: { [MAX_WEBHOOK_ROUTE_CONFIG_KEY]: true } }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      handlerSettled = true;
      return { ok: true };
    });

    try {
      const response = await fastify.inject({ method: 'POST', url: '/webhook' });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'FST_ERR_HANDLER_TIMEOUT' });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(handlerSettled).toBe(true);
      expect(response.statusCode).toBe(503);
    } finally {
      await fastify.close();
    }
  });

  it('enforces the marked webhook timeout through the real Nest route config', async () => {
    let observedHandlerTimeout: number | undefined;
    let observedWorkDeadlineAtMs: number | null | undefined;
    let handlerSettled = false;
    const ingestionService = {
      ingest: jest.fn(async (...args: Parameters<WebhookIngestionService['ingest']>) => {
        const [, , request, deadlineAtMs] = args;
        observedHandlerTimeout = (
          request as unknown as { routeOptions: { handlerTimeout?: number } }
        ).routeOptions.handlerTimeout;
        observedWorkDeadlineAtMs = deadlineAtMs;
        await new Promise((resolve) => setTimeout(resolve, 200));
        handlerSettled = true;
        return { ok: true, duplicate: false, acceptedAt: new Date().toISOString() };
      }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [{ provide: WebhookIngestionService, useValue: ingestionService }],
    }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    const fastify = app.getHttpAdapter().getInstance();
    registerMaxWebhookHttpRouteLimits(fastify, {
      bodyLimit: 512 * 1024,
      ackDeadlineMs: 100,
    });
    app.useGlobalFilters(new SanitizedExceptionFilter());
    app.setGlobalPrefix('api');

    try {
      await app.init();
      await fastify.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/api/webhook/max/bot-1/secret-path',
        payload: {},
      });

      expect(response.statusCode).toBe(503);
      expect(observedHandlerTimeout).toBe(100);
      expect(observedWorkDeadlineAtMs).toEqual(expect.any(Number));
      await new Promise((resolve) => setTimeout(resolve, 125));
      expect(handlerSettled).toBe(true);
      expect(response.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});

describe('MAX webhook pre-body admission and route outcomes', () => {
  it('rejects invalid credentials before invoking the content parser or handler', async () => {
    const fastify = Fastify();
    const phases: string[] = [];
    const recordRouteOutcome = jest.fn();
    registerMaxWebhookHttpRouteLimits(fastify, {
      bodyLimit: DEFAULT_MAX_WEBHOOK_BODY_LIMIT_BYTES,
      ackDeadlineMs: 5_000,
      admitRequest: async (request) => {
        phases.push('admission');
        expect(request.params).toEqual({ botId: 'bot-1', secretPath: 'wrong' });
        return {
          accepted: false,
          botId: null,
          outcome: 'authentication_rejected',
          statusCode: 403,
        };
      },
      recordRouteOutcome,
    });
    fastify.addContentTypeParser(
      'application/x-maxim-webhook',
      { parseAs: 'string' },
      (_request, _body, done) => {
        phases.push('bodyParser');
        done(null, {});
      },
    );
    fastify.post(
      '/webhook/:botId/:secretPath',
      { config: { [MAX_WEBHOOK_ROUTE_CONFIG_KEY]: true } },
      async () => {
        phases.push('handler');
        return { ok: true };
      },
    );

    try {
      const response = await fastify.inject({
        method: 'POST',
        url: '/webhook/bot-1/wrong',
        headers: { 'content-type': 'application/x-maxim-webhook' },
        payload: '{"padding":"'.padEnd(128 * 1_024, 'x'),
      });

      expect(response.statusCode).toBe(403);
      expect(phases).toEqual(['admission']);
      expect(recordRouteOutcome).toHaveBeenCalledWith({
        botId: null,
        outcome: 'authentication_rejected',
      });
    } finally {
      await fastify.close();
    }
  });

  it.each([
    {
      name: 'malformed JSON',
      bodyLimit: 1_024,
      payload: '{',
      expectedStatus: 400,
      expectedOutcome: 'invalid_json',
    },
    {
      name: 'oversized payload',
      bodyLimit: 8,
      payload: JSON.stringify({ value: 'too-large' }),
      expectedStatus: 413,
      expectedOutcome: 'payload_too_large',
    },
  ])('records $name separately from receipt persistence', async (testCase) => {
    const fastify = Fastify();
    const recordRouteOutcome = jest.fn();
    registerMaxWebhookHttpRouteLimits(fastify, {
      bodyLimit: testCase.bodyLimit,
      ackDeadlineMs: 5_000,
      admitRequest: async () => ({ accepted: true, botId: 'bot-1' }),
      recordRouteOutcome,
    });
    fastify.post('/webhook', { config: { [MAX_WEBHOOK_ROUTE_CONFIG_KEY]: true } }, async () => ({
      ok: true,
    }));

    try {
      const response = await fastify.inject({
        method: 'POST',
        url: '/webhook',
        headers: { 'content-type': 'application/json' },
        payload: testCase.payload,
      });

      expect(response.statusCode).toBe(testCase.expectedStatus);
      expect(recordRouteOutcome).toHaveBeenCalledWith({
        botId: 'bot-1',
        outcome: testCase.expectedOutcome,
      });
    } finally {
      await fastify.close();
    }
  });

  it.each([
    {
      name: 'status property',
      createError: () => Object.assign(new Error('invalid payload'), { status: 400 }),
    },
    {
      name: 'Nest getStatus method',
      createError: () => Object.assign(new Error('invalid payload'), { getStatus: () => 400 }),
    },
  ])('classifies a 400 from the $name as invalid payload', async ({ createError }) => {
    const fastify = Fastify();
    const recordRouteOutcome = jest.fn();
    registerMaxWebhookHttpRouteLimits(fastify, {
      bodyLimit: 1_024,
      ackDeadlineMs: 5_000,
      admitRequest: async () => ({ accepted: true, botId: 'bot-1' }),
      recordRouteOutcome,
    });
    fastify.post('/webhook', { config: { [MAX_WEBHOOK_ROUTE_CONFIG_KEY]: true } }, async () => {
      throw createError();
    });

    try {
      await fastify.inject({ method: 'POST', url: '/webhook', payload: {} });

      expect(recordRouteOutcome).toHaveBeenCalledWith({
        botId: 'bot-1',
        outcome: 'invalid_payload',
      });
    } finally {
      await fastify.close();
    }
  });

  it('records schema rejection and successful ACK as explicit route outcomes', async () => {
    const fastify = Fastify();
    const recordRouteOutcome = jest.fn();
    registerMaxWebhookHttpRouteLimits(fastify, {
      bodyLimit: 1_024,
      ackDeadlineMs: 5_000,
      admitRequest: async () => ({ accepted: true, botId: 'bot-1' }),
      recordRouteOutcome,
    });
    fastify.post(
      '/invalid',
      { config: { [MAX_WEBHOOK_ROUTE_CONFIG_KEY]: true } },
      async (_request, reply) => reply.code(400).send({ statusCode: 400 }),
    );
    fastify.post('/accepted', { config: { [MAX_WEBHOOK_ROUTE_CONFIG_KEY]: true } }, async () => ({
      ok: true,
    }));

    try {
      const invalid = await fastify.inject({ method: 'POST', url: '/invalid', payload: {} });
      const accepted = await fastify.inject({ method: 'POST', url: '/accepted', payload: {} });

      expect(invalid.statusCode).toBe(400);
      expect(accepted.statusCode).toBe(200);
      expect(recordRouteOutcome).toHaveBeenNthCalledWith(1, {
        botId: 'bot-1',
        outcome: 'invalid_payload',
      });
      expect(recordRouteOutcome).toHaveBeenNthCalledWith(2, {
        botId: 'bot-1',
        outcome: 'accepted',
      });
    } finally {
      await fastify.close();
    }
  });
});
