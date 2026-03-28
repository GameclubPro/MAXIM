import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { AdminModule } from './admin/admin.module';
import { validateEnv } from './config/env.schema';
import { HealthModule } from './health/health.module';
import { MaxModule } from './max/max.module';
import { ModerationModule } from './moderation/moderation.module';
import { PrismaModule } from './prisma/prisma.module';
import { SystemModule } from './system/system.module';
import { WebhookModule } from './webhook/webhook.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      expandVariables: true,
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        transport:
          process.env.NODE_ENV === 'production'
            ? undefined
            : {
                target: 'pino-pretty',
                options: {
                  singleLine: true,
                },
              },
        redact: [
          'req.headers.authorization',
          'req.headers.x-max-secret',
          'req.headers.x-max-bot-api-secret',
          'req.url',
        ],
      },
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.getOrThrow<string>('REDIS_URL'),
        },
      }),
    }),
    PrismaModule,
    MaxModule,
    ModerationModule,
    WebhookModule,
    AdminModule,
    SystemModule,
    HealthModule,
  ],
})
export class AppModule {}
