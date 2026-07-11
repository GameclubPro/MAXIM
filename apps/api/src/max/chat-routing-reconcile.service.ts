import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsEnqueue } from '../runtime/app-role';
import { MaxBotLinkService } from './max-bot-link.service';

const DEFAULT_RECONCILE_INTERVAL_MS = 500;
const DEFAULT_RECONCILE_BATCH_SIZE = 250;
const DEFAULT_RECONCILE_CONCURRENCY = 8;
const REQUEUE_DELAY_MS = 5_000;
const RECONCILE_LEASE_MS = 30_000;

type ChatRoutingReconcileRequest = {
  chat_id: string;
  generation: bigint;
};

type ClaimedChatRoutingRequests = {
  leaseToken: string;
  requests: ChatRoutingReconcileRequest[];
};

@Injectable()
export class ChatRoutingReconcileService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatRoutingReconcileService.name);
  private readonly enabled = roleRunsEnqueue(getAppRole());
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly concurrency: number;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxBotLinkService: MaxBotLinkService,
    configService: ConfigService,
  ) {
    this.intervalMs = configService.get<number>(
      'CHAT_ROUTING_RECONCILE_INTERVAL_MS',
      DEFAULT_RECONCILE_INTERVAL_MS,
    );
    this.batchSize = configService.get<number>(
      'CHAT_ROUTING_RECONCILE_BATCH_SIZE',
      DEFAULT_RECONCILE_BATCH_SIZE,
    );
    this.concurrency = configService.get<number>(
      'CHAT_ROUTING_RECONCILE_CONCURRENCY',
      DEFAULT_RECONCILE_CONCURRENCY,
    );
  }

  onModuleInit(): void {
    if (!this.enabled) {
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.inFlight) {
      return;
    }

    this.inFlight = true;
    try {
      await this.reconcileBatch();
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to reconcile dirty chat routing state batch',
      );
    } finally {
      this.inFlight = false;
    }
  }

  private async reconcileBatch(): Promise<number> {
    const { leaseToken, requests } = await this.claimRequests();
    if (requests.length === 0) {
      return 0;
    }

    let nextIndex = 0;
    const workerCount = Math.max(1, Math.min(this.concurrency, requests.length));
    const runWorker = async () => {
      while (true) {
        const request = requests[nextIndex];
        nextIndex += 1;
        if (!request) {
          return;
        }
        await this.reconcileRequest(request, leaseToken);
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    return requests.length;
  }

  private async claimRequests(): Promise<ClaimedChatRoutingRequests> {
    const now = new Date();
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + RECONCILE_LEASE_MS);
    const requests = await this.prisma.$queryRaw<ChatRoutingReconcileRequest[]>(Prisma.sql`
      WITH candidates AS (
        SELECT request."chat_id", request."generation"
        FROM "chat_routing_reconcile_requests" request
        WHERE request."requested_at" <= ${now}
          AND (
            request."lease_expires_at" IS NULL
            OR request."lease_expires_at" < ${now}
          )
        ORDER BY request."requested_at" ASC, request."chat_id" ASC
        LIMIT ${this.batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "chat_routing_reconcile_requests" request
      SET
        "lease_token" = ${leaseToken},
        "lease_expires_at" = ${leaseExpiresAt}
      FROM candidates
      WHERE request."chat_id" = candidates."chat_id"
        AND request."generation" = candidates."generation"
      RETURNING request."chat_id", request."generation"
    `);
    return { leaseToken, requests };
  }

  private async reconcileRequest(
    request: ChatRoutingReconcileRequest,
    leaseToken: string,
  ): Promise<void> {
    try {
      await this.maxBotLinkService.reconcileChatRoutingState({
        chatId: request.chat_id,
        forceVersionBump: true,
      });
      await this.completeRequest(request, leaseToken);
    } catch (error: unknown) {
      await this.requeueRequest(request, leaseToken).catch((requeueError: unknown) => {
        this.logger.error(
          {
            chatId: request.chat_id,
            generation: request.generation.toString(),
            err: requeueError instanceof Error ? requeueError.message : String(requeueError),
          },
          'Failed to release chat routing reconciliation lease; expiry will recover it',
        );
      });
      this.logger.warn(
        {
          chatId: request.chat_id,
          generation: request.generation.toString(),
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to reconcile dirty chat routing state; request was requeued',
      );
    }
  }

  private async completeRequest(
    request: ChatRoutingReconcileRequest,
    leaseToken: string,
  ): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      DELETE FROM "chat_routing_reconcile_requests"
      WHERE "chat_id" = ${request.chat_id}
        AND "generation" = ${request.generation}
        AND "lease_token" = ${leaseToken}
    `);
  }

  private async requeueRequest(
    request: ChatRoutingReconcileRequest,
    leaseToken: string,
  ): Promise<void> {
    const retryAt = new Date(Date.now() + REQUEUE_DELAY_MS);
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "chat_routing_reconcile_requests"
      SET
        "requested_at" = ${retryAt},
        "lease_token" = NULL,
        "lease_expires_at" = NULL
      WHERE "chat_id" = ${request.chat_id}
        AND "generation" = ${request.generation}
        AND "lease_token" = ${leaseToken}
    `);
  }
}
