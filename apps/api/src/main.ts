import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { SanitizedExceptionFilter } from './common/sanitized-exception.filter';
import { getAppRole, resolveHttpListenHost, roleRunsHttp } from './runtime/app-role';

async function bootstrap() {
  const bodyLimit = Number(process.env.JSON_BODY_LIMIT ?? 33_554_432);
  const port = Number(process.env.PORT ?? 3001);
  const role = getAppRole();
  const httpEnabled = roleRunsHttp(role);

  if (!httpEnabled) {
    const context = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
    context.useLogger(context.get(Logger));
    context.enableShutdownHooks();
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
  app.enableShutdownHooks();
  app.useGlobalFilters(new SanitizedExceptionFilter());
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: true,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', (request, reply, payload, done) => {
      if (request.url.startsWith('/api/')) {
        reply
          .header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
          .header('Pragma', 'no-cache')
          .header('Expires', '0');
      }

      done(null, payload);
    });

  await app.listen(port, resolveHttpListenHost());
}

void bootstrap();
