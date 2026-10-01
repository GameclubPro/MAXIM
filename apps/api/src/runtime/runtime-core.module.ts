import { BullModule } from '@nestjs/bullmq';
import { Module, RequestMethod } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { HTTP_LOG_REDACT_PATHS } from '../common/http-log-redaction';
import { validateEnv } from '../config/env.schema';
import { MaxBotModule } from '../max/max-bot.module';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageRuntimeMetricsModule } from '../system/storage-runtime-metrics.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, expandVariables: true }),
    LoggerModule.forRoot({
      forRoutes: [{ path: '{*path}', method: RequestMethod.ALL }],
      pinoHttp: {
        level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        transport:
          process.env.NODE_ENV === 'production'
            ? undefined
            : { target: 'pino-pretty', options: { singleLine: true } },
        redact: HTTP_LOG_REDACT_PATHS,
      },
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: { url: config.getOrThrow<string>('REDIS_URL') },
      }),
    }),
    StorageRuntimeMetricsModule,
    PrismaModule,
    MaxBotModule,
  ],
})
export class RuntimeCoreModule {}
