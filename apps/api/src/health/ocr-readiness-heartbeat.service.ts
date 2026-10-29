import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { resolveImageTextStopListOcrRuntimePolicy } from '../moderation/commercial-ocr/image-text-stop-list.runtime';
import { HealthService } from './health.service';
import {
  OcrReadinessStateService,
  type OcrReadinessHeartbeat,
} from './ocr-readiness-state.service';

export const OCR_READINESS_HEARTBEAT_INTERVAL_MS = 5_000;

@Injectable()
export class OcrReadinessHeartbeatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OcrReadinessHeartbeatService.name);
  private readonly bootId = randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly config: ConfigService,
    private readonly health: HealthService,
    private readonly state: OcrReadinessStateService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.config.get<string>('APP_SERVICE_NAME') !== 'api-media-analysis') return;
    await this.refresh();
    if (this.stopping) return;
    this.timer = setInterval(() => void this.refresh(), OCR_READINESS_HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.inFlight;
    if (this.config.get<string>('APP_SERVICE_NAME') === 'api-media-analysis')
      await this.state.release(this.bootId);
  }

  private refresh(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const pending = this.publish().catch(() => {
      this.logger.warn('OCR readiness heartbeat unavailable');
    });
    this.inFlight = pending;
    void pending.finally(() => {
      if (this.inFlight === pending) this.inFlight = null;
    });
    return pending;
  }

  private async publish(): Promise<void> {
    // FLAG: Sample the existing cached readiness only. A diagnostic heartbeat must never
    // start OCR work, MAX requests, a native probe, or a cross-role HTTP request.
    const readiness = this.health.ocrReady();
    const identity = readiness.checks.ocr.behaviorIdentity;
    const identityVerified =
      identity.required && identity.complete && identity.verified && identity.state === 'verified';
    const heartbeat: OcrReadinessHeartbeat = {
      version: 1,
      serviceName: 'api-media-analysis',
      bootId: this.bootId,
      observedAt: readiness.timestamp,
      mode: resolveImageTextStopListOcrRuntimePolicy({
        configService: this.config,
        sandboxBoundaryVerified: false,
      }).mode,
      ready: readiness.ok && readiness.checks.ocr.ready && identityVerified,
      identityVerified,
    };
    await this.state.publish(heartbeat);
  }
}
