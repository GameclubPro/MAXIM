import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminModule } from '../admin/admin.module';
import { ChatContextModule } from '../chat-context/chat-context.module';
import { MaxModule } from '../max/max.module';
import { getAppRole, roleRunsModeration } from '../runtime/app-role';
import {
  commercialOcrProcessorEnabled,
  getEnabledModerationProcessorQueues,
  getWebhookDynamicLeasesWorkerGroup,
  spammerDenormProcessorEnabled,
} from '../runtime/moderation-runtime';
import {
  MODERATION_EXECUTION_LEGACY,
  ModerationExecutionService,
} from './moderation-execution.service';
import { NightModeTransitionModule } from './night-mode-transition.module';
import { NightModeTransitionDeliveryService } from './night-mode-transition-delivery.service';
import { NightModeTransitionRuntimeService } from './night-mode-transition-runtime.service';
import { NightModeTransitionProcessor } from './night-mode-transition.processor';
import { GlobalSpammerDenormProcessor } from './global-spammer-denorm.processor';
import { GLOBAL_SPAMMER_DENORM_QUEUE } from './global-spammer-denorm.queue';
import { SystemModule } from '../system/system.module';
import { KaravanStorefrontRelayModule } from '../integrations/karavan-storefront/karavan-storefront-relay.module';
import {
  BackgroundWebhookProcessor,
  CriticalWebhookProcessor,
  DEFAULT_WEBHOOK_SHARD_PROCESSORS,
  JOIN_WEBHOOK_SHARD_PROCESSORS,
  LegacyModerationProcessor,
  ModerationService,
} from './moderation.service';
import { DefaultWebhookLeaseManagerService } from './default-webhook-lease-manager.service';
import { GlobalSpammerArchiveRunnerService } from './global-spammer-archive-runner.service';
import {
  ALL_WEBHOOK_QUEUE_NAMES,
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  JOIN_WEBHOOK_QUEUE_NAMES,
  LEGACY_WEBHOOK_QUEUE,
  WEBHOOK_QUEUE_BACKGROUND,
  WEBHOOK_QUEUE_CRITICAL,
} from '../webhook/webhook-queues';
import { PrivateControlController } from './private-control.controller';
import { PrivateControlService } from './private-control.service';
import { ModerationAccessService } from './moderation-access.service';
import { GlobalSpammerIntelligenceService } from './global-spammer-intelligence.service';
import { RedisCounterModule } from './redis-counter.module';
import { RuleEngineService } from './rule-engine.service';
import { SanctionService } from './sanction.service';
import { BotSpeechMediaService } from './bot-speech-media.service';
import { NightModeTransitionEventService } from './night-mode-transition-event.service';
import { WebhookCanonicalExecutionService } from './webhook-canonical-execution.service';
import { ModerationDeleteIntentModule } from './moderation-delete-intent.module';
import { PHOTO_DUPLICATE_QUEUE } from './photo-duplicate/photo-duplicate.queue';
import { PhotoDuplicateEnqueueService } from './photo-duplicate/photo-duplicate-enqueue.service';
import { PhotoDuplicateProcessor } from './photo-duplicate/photo-duplicate.processor';
import { PhotoDuplicateAnalysisService } from './photo-duplicate/photo-duplicate-analysis.service';
import { PhotoDuplicateHistoryStore } from './photo-duplicate/photo-duplicate-history.store';
import { PhotoFingerprintService } from './photo-duplicate/photo-fingerprint';
import { SecurePhotoDownloader } from './photo-duplicate/secure-photo-downloader';
import { PhotoDuplicateOrderingStore } from './photo-duplicate/photo-duplicate-ordering.store';
import { PHOTO_DUPLICATE_MODERATION_ACTIONS } from './photo-duplicate/photo-duplicate-moderation.actions';
import { PhotoDuplicateModerationActionsService } from './photo-duplicate/photo-duplicate-moderation-actions.service';
import { PhotoDuplicateModerationService } from './photo-duplicate/photo-duplicate-moderation.service';
import { LinkHistoryRecoveryService } from './link-history-recovery.service';
import { CommercialOcrAdmissionStore } from './commercial-ocr/commercial-ocr-admission.store';
import { CommercialOcrAnalysisService } from './commercial-ocr/commercial-ocr-analysis.service';
import { CommercialOcrCacheStore } from './commercial-ocr/commercial-ocr-cache.store';
import { CommercialOcrEnqueueService } from './commercial-ocr/commercial-ocr-enqueue.service';
import { CommercialOcrModerationService } from './commercial-ocr/commercial-ocr-moderation.service';
import { CommercialOcrMetricsService } from './commercial-ocr/commercial-ocr-metrics.service';
import { CommercialOcrPreprocessor } from './commercial-ocr/commercial-ocr-preprocessor';
import { CommercialOcrProcessor } from './commercial-ocr/commercial-ocr.processor';
import { CommercialOcrQueueProducer } from './commercial-ocr/commercial-ocr-queue.producer';
import { COMMERCIAL_OCR_QUEUE } from './commercial-ocr/commercial-ocr.queue';
import { NativeTesseractOcrAdapter } from './commercial-ocr/native-tesseract-ocr.adapter';

const enabledModerationQueues = getEnabledModerationProcessorQueues();
const dynamicDefaultWorkerGroup = getWebhookDynamicLeasesWorkerGroup();
const moderationRoleEnabled = roleRunsModeration(getAppRole());
const photoDuplicateProcessorEnabled =
  moderationRoleEnabled && enabledModerationQueues.has(WEBHOOK_QUEUE_BACKGROUND);
const commercialOcrWorkerEnabled = commercialOcrProcessorEnabled();
const commercialOcrEnqueueEnabled = moderationRoleEnabled && enabledModerationQueues.size > 0;
const moderationProviders = [
  ModerationService,
  {
    provide: MODERATION_EXECUTION_LEGACY,
    useExisting: ModerationService,
  },
  {
    provide: PHOTO_DUPLICATE_MODERATION_ACTIONS,
    useExisting: PhotoDuplicateModerationActionsService,
  },
  PhotoDuplicateModerationActionsService,
  ModerationExecutionService,
  ModerationAccessService,
  BotSpeechMediaService,
  NightModeTransitionEventService,
  NightModeTransitionDeliveryService,
  NightModeTransitionRuntimeService,
  PrivateControlService,
  GlobalSpammerIntelligenceService,
  GlobalSpammerArchiveRunnerService,
  RuleEngineService,
  SanctionService,
  WebhookCanonicalExecutionService,
  LinkHistoryRecoveryService,
  PhotoDuplicateEnqueueService,
  ...(moderationRoleEnabled ? [PhotoDuplicateOrderingStore] : []),
  ...(commercialOcrEnqueueEnabled || commercialOcrWorkerEnabled
    ? [CommercialOcrAdmissionStore, CommercialOcrMetricsService]
    : []),
  ...(commercialOcrEnqueueEnabled
    ? [
        {
          provide: CommercialOcrQueueProducer,
          inject: [ConfigService],
          useFactory: (configService: ConfigService) =>
            new CommercialOcrQueueProducer(configService.getOrThrow<string>('REDIS_URL')),
        },
        CommercialOcrEnqueueService,
      ]
    : []),
  ...(photoDuplicateProcessorEnabled || commercialOcrWorkerEnabled ? [SecurePhotoDownloader] : []),
  ...(dynamicDefaultWorkerGroup ? [DefaultWebhookLeaseManagerService] : []),
  ...(moderationRoleEnabled
    ? [
        ...(enabledModerationQueues.has(LEGACY_WEBHOOK_QUEUE) ? [LegacyModerationProcessor] : []),
        ...(enabledModerationQueues.has(WEBHOOK_QUEUE_CRITICAL) ? [CriticalWebhookProcessor] : []),
        ...JOIN_WEBHOOK_QUEUE_NAMES.flatMap((queueName, index) =>
          enabledModerationQueues.has(queueName) ? [JOIN_WEBHOOK_SHARD_PROCESSORS[index]!] : [],
        ),
        ...(dynamicDefaultWorkerGroup
          ? []
          : DEFAULT_WEBHOOK_QUEUE_NAMES.flatMap((queueName, index) =>
              enabledModerationQueues.has(queueName)
                ? [DEFAULT_WEBHOOK_SHARD_PROCESSORS[index]!]
                : [],
            )),
        ...(enabledModerationQueues.has(WEBHOOK_QUEUE_BACKGROUND)
          ? [BackgroundWebhookProcessor]
          : []),
        ...(enabledModerationQueues.has(WEBHOOK_QUEUE_BACKGROUND) &&
        roleRunsModeration(getAppRole())
          ? [NightModeTransitionProcessor]
          : []),
        ...(spammerDenormProcessorEnabled() ? [GlobalSpammerDenormProcessor] : []),
        ...(photoDuplicateProcessorEnabled
          ? [
              PhotoDuplicateHistoryStore,
              {
                provide: PhotoFingerprintService,
                inject: [ConfigService],
                useFactory: (configService: ConfigService) =>
                  new PhotoFingerprintService({
                    maxInputBytes:
                      configService.get<number>('PHOTO_DUPLICATE_MAX_BYTES') ?? 16_777_216,
                    maxInputPixels:
                      configService.get<number>('PHOTO_DUPLICATE_MAX_PIXELS') ?? 40_000_000,
                  }),
              },
              PhotoDuplicateAnalysisService,
              PhotoDuplicateModerationService,
              PhotoDuplicateProcessor,
            ]
          : []),
        ...(commercialOcrWorkerEnabled
          ? [
              CommercialOcrCacheStore,
              CommercialOcrPreprocessor,
              NativeTesseractOcrAdapter,
              CommercialOcrAnalysisService,
              CommercialOcrModerationService,
              CommercialOcrProcessor,
            ]
          : []),
      ]
    : []),
];

@Module({
  imports: [
    BullModule.registerQueue(...ALL_WEBHOOK_QUEUE_NAMES.map((name) => ({ name }))),
    BullModule.registerQueue({ name: GLOBAL_SPAMMER_DENORM_QUEUE }),
    BullModule.registerQueue({ name: PHOTO_DUPLICATE_QUEUE }),
    ...(commercialOcrWorkerEnabled
      ? [BullModule.registerQueue({ name: COMMERCIAL_OCR_QUEUE })]
      : []),
    MaxModule,
    SystemModule,
    ChatContextModule,
    AdminModule,
    NightModeTransitionModule,
    RedisCounterModule,
    KaravanStorefrontRelayModule,
    ModerationDeleteIntentModule,
  ],
  controllers: [PrivateControlController],
  providers: moderationProviders,
  exports: [
    ModerationExecutionService,
    ModerationService,
    ModerationDeleteIntentModule,
    GlobalSpammerIntelligenceService,
    ...(commercialOcrEnqueueEnabled || commercialOcrWorkerEnabled
      ? [CommercialOcrMetricsService]
      : []),
    ...(commercialOcrWorkerEnabled ? [NativeTesseractOcrAdapter] : []),
  ],
})
export class ModerationModule {}
