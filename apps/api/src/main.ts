import fastifyCookie from '@fastify/cookie';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { MiniappRequestSecurityService } from './auth/miniapp-request-security.service';
import { SanitizedExceptionFilter } from './common/sanitized-exception.filter';
import { getAppRole, resolveHttpListenHost, roleRunsHttp } from './runtime/app-role';
import { installRuntimeWorkerShutdown } from './runtime/runtime-worker-shutdown';
import { WebhookIngressMetricsService } from './system/webhook-ingress-metrics.service';
import {
  readMaxWebhookAckDeadlineAtMs,
  registerMaxWebhookHttpRouteLimits,
} from './webhook/webhook-http-route-limit';
import { WebhookIngestionService } from './webhook/webhook-ingestion.service';

async function bootstrap() {
  const bodyLimit = Number(process.env.JSON_BODY_LIMIT ?? 33_554_432);
  const port = Number(process.env.PORT ?? 3001);
  const role = getAppRole();
  const httpEnabled = roleRunsHttp(role);

  if (!httpEnabled) {
    const context = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
    context.useLogger(context.get(Logger));
    installRuntimeWorkerShutdown(context);
    return;
  }

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit }),
    {
      bufferLogs: true,
    },
  );

  app.useLogger(app.get(Logger));
  const configService = app.get(ConfigService);
  const webhookIngestionService = app.get(WebhookIngestionService);
  const webhookIngressMetricsService = app.get(WebhookIngressMetricsService);
  const miniappRequestSecurity = app.get(MiniappRequestSecurityService);
  const webhookBodyLimit = configService.getOrThrow<number>('WEBHOOK_BODY_LIMIT_BYTES');
  const webhookAckDeadlineMs = configService.getOrThrow<number>('WEBHOOK_ACK_DEADLINE_MS');
  app.useGlobalFilters(new SanitizedExceptionFilter());
  const fastify = app.getHttpAdapter().getInstance();
  await app.register(fastifyCookie);
  registerMaxWebhookHttpRouteLimits(fastify, {
    bodyLimit: webhookBodyLimit,
    ackDeadlineMs: webhookAckDeadlineMs,
    admitRequest: (request) => {
      const params = request.params as { botId?: unknown; secretPath?: unknown };
      return webhookIngestionService.admitBeforeBody(
        {
          botId: typeof params.botId === 'string' ? params.botId : '',
          secretPath: typeof params.secretPath === 'string' ? params.secretPath : '',
        },
        request,
        readMaxWebhookAckDeadlineAtMs(request),
      );
    },
    recordRouteOutcome: (metric) => webhookIngressMetricsService.recordRouteOutcome(metric),
  });
  app.setGlobalPrefix('api');
  const allowDevelopmentLoopback = configService.get<string>('NODE_ENV') !== 'production';
  app.enableCors({
    origin: (origin, callback) => {
      const allowed =
        miniappRequestSecurity.isCorsOriginAllowed(origin) ||
        (allowDevelopmentLoopback &&
          origin !== undefined &&
          /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/u.test(origin));
      callback(null, allowed);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  fastify.addHook('onSend', (request, reply, payload, done) => {
    if (request.url.startsWith('/api/')) {
      reply
        .header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        .header('Pragma', 'no-cache')
        .header('Expires', '0');
    }

    done(null, payload);
  });

  await app.init();
  installRuntimeWorkerShutdown(app);
  await app.listen(port, resolveHttpListenHost());
}

void bootstrap();
