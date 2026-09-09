import { publicationPostPublishSchema } from '@maxim/contracts/publication';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PUBLICATION_DELIVERY_VERIFICATION_RESET_DATA } from '../admin/publication-delivery-verification-state';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import { type Prisma, PublicationPostActionStatus as Status } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { BackgroundRuntimeGovernorService } from '../system/background-runtime-governor.service';
import { PublisherActionCredentialService } from './publisher-action-credential.service';
import { PublisherBackgroundWorkCoordinatorService } from './publisher-background-work-coordinator.service';
import {
  extractPublisherMaxStatusCode,
  PublisherDispatchHealthService,
} from './publisher-dispatch-health.service';
import { PublisherIdentityAttestationService } from './publisher-identity-attestation.service';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';

const POLL_MS = 5_000;
const LEASE_MS = 120_000;
const BATCH_SIZE = 20;
const SWEEP_BUDGET_MS = 10_000;
const MAX_DELETE_ATTEMPTS = 10;
const MAX_PIN_ATTEMPTS = 10;
const PIN_UNCONFIRMED = 'Закрепление не подтверждено. Проверьте пост в MAX.';

const actionSelect = {
  id: true,
  updatedAt: true,
  targetChatId: true,
  botId: true,
  requiredBotId: true,
  remoteMessageId: true,
  sentAt: true,
  postActionsNextAt: true,
  pinStatus: true,
  pinAttemptCount: true,
  deleteStatus: true,
  deleteAt: true,
  deleteAttemptCount: true,
  contentRevision: { select: { postPublish: true } },
} satisfies Prisma.ManagedBroadcastDeliverySelect;
type Delivery = Prisma.ManagedBroadcastDeliveryGetPayload<{ select: typeof actionSelect }>;

@Injectable()
export class PublisherPublicationPostActionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherPublicationPostActionsService.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private closing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly max: MaxClientService,
    private readonly boundary: PublisherRuntimeBoundaryService,
    private readonly identity: PublisherIdentityAttestationService,
    private readonly health: PublisherDispatchHealthService,
    private readonly credentials: PublisherActionCredentialService,
    private readonly background: PublisherBackgroundWorkCoordinatorService,
    private readonly governor: BackgroundRuntimeGovernorService,
  ) {}

  onModuleInit(): void {
    if (!this.boundary.dispatchEnabled) return;
    this.timer = setInterval(() => this.trigger(), POLL_MS);
    this.timer.unref();
    this.trigger();
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await this.inFlight;
  }

  async processDue(): Promise<void> {
    if (this.closing || !this.boundary.dispatchEnabled) return;
    await this.background.runExclusive('publication_post_actions', async () => {
      if (this.closing || (await this.health.isGloballyPaused())) return;
      const decision = await this.governor.decide({
        component: 'publication-post-actions',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
        allowMaxApiCapacitySlowPath: true,
      });
      if (decision.action === 'pause') return;
      await this.identity.assertAttested();
      const rows = await this.prisma.managedBroadcastDelivery.findMany({
        where: {
          dispatchProfile: 'PUBLIK_V1',
          status: 'SENT',
          postActionsNextAt: { lte: new Date() },
        },
        orderBy: [{ postActionsNextAt: 'asc' }, { id: 'asc' }],
        take: decision.action === 'slow' ? 1 : BATCH_SIZE,
        select: actionSelect,
      });
      const sweepStartedAt = Date.now();
      for (const row of rows) {
        if (this.closing || Date.now() - sweepStartedAt >= SWEEP_BUDGET_MS) break;
        try {
          await this.processDelivery(row);
        } catch {
          // FLAG: Database failures leave the lease and dispatch fence for bounded recovery.
          this.logger.warn('Publication post-action deferred; durable state retained');
        }
      }
    });
  }

  private async processDelivery(row: Delivery): Promise<void> {
    const token = randomUUID();
    const leaseUntil = new Date(Date.now() + LEASE_MS);
    const claimed = await this.prisma.managedBroadcastDelivery.updateMany({
      where: {
        id: row.id,
        dispatchProfile: 'PUBLIK_V1',
        status: 'SENT',
        postActionsNextAt: row.postActionsNextAt,
        updatedAt: row.updatedAt,
        pinStatus: row.pinStatus,
        deleteStatus: row.deleteStatus,
        deleteAt: row.deleteAt,
      },
      data: { postActionsToken: token, postActionsNextAt: leaseUntil },
    });
    if (!claimed.count) return;
    const persist = async (data: Prisma.ManagedBroadcastDeliveryUpdateManyMutationInput) => {
      const result = await this.prisma.managedBroadcastDelivery.updateMany({
        where: {
          id: row.id,
          postActionsToken: token,
          status: 'SENT',
          dispatchProfile: 'PUBLIK_V1',
          remoteMessageId: row.remoteMessageId,
          botId: row.botId,
          requiredBotId: row.requiredBotId,
        },
        data,
      });
      if (!result.count) throw new Error('Publication post-action lease lost');
    };
    const parsed = publicationPostPublishSchema.safeParse(row.contentRevision?.postPublish ?? {});
    const botId = this.credentials.getBotId();
    if (
      !parsed.success ||
      !row.sentAt ||
      !row.remoteMessageId ||
      row.botId !== botId ||
      row.requiredBotId !== botId
    ) {
      await persist({
        pinStatus: Status.FAILED,
        deleteStatus: Status.FAILED,
        pinError: 'Не удалось подтвердить исходный пост.',
        deleteError: 'Не удалось подтвердить исходный пост.',
        postActionsNextAt: null,
        postActionsToken: null,
      });
      return;
    }
    const policy = parsed.data;
    const deleteAt =
      row.deleteStatus === Status.SKIPPED
        ? null
        : (row.deleteAt ??
          (policy.deleteAfterMinutes === null
            ? null
            : new Date(row.sentAt.getTime() + policy.deleteAfterMinutes * 60_000)));
    let pinStatus = row.pinStatus;
    let deleteStatus = row.deleteStatus;
    const options = {
      botId,
      trafficClass: 'background' as const,
      sourceTag: MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
      timeoutMs: 10_000,
    };
    const guard = async () => {
      this.boundary.assertDispatchEnabled();
      await this.health.assertDispatchAllowed();
      if (this.closing || Date.now() >= leaseUntil.getTime())
        throw new Error('Publication post-action lease expired');
      const binding = await this.prisma.publisherEntityBinding.findFirst({
        where: { chatId: row.targetChatId, publisherBotId: botId, status: 'ACTIVE' },
        select: { chatId: true },
      });
      if (!binding) throw new Error('Publisher binding unavailable');
      await persist({ postActionsToken: token });
    };

    // FLAG: An interrupted pin may already have notified MAX members. Never replay it.
    if (pinStatus === Status.RUNNING) {
      pinStatus = Status.AMBIGUOUS;
      await persist({ pinStatus, pinError: PIN_UNCONFIRMED });
    }
    if (deleteAt && (deleteStatus === Status.NONE || !row.deleteAt)) {
      deleteStatus = Status.PENDING;
      await persist({ deleteAt, deleteStatus });
    }
    let pinNextAt: Date | null = null;
    if (policy.pin !== 'none' && (pinStatus === Status.NONE || pinStatus === Status.PENDING)) {
      if (deleteAt && deleteAt.getTime() <= Date.now()) {
        pinStatus = Status.SKIPPED;
        await persist({ pinStatus, pinError: null });
      } else {
        const attempt = row.pinAttemptCount + 1;
        await persist({ pinAttemptCount: attempt });
        let dispatched = false;
        try {
          await this.max.pinMessage(
            row.targetChatId,
            row.remoteMessageId,
            policy.pin === 'notify',
            {
              ...options,
              beforeMutation: async () => {
                await guard();
                if (deleteAt && deleteAt.getTime() <= Date.now()) throw new Error('Post expired');
                await persist({ pinStatus: Status.RUNNING });
                dispatched = true;
              },
            },
          );
          pinStatus = Status.DONE;
        } catch (error: unknown) {
          const status = extractPublisherMaxStatusCode(error);
          const rejected = status !== null && [400, 401, 403, 404, 422].includes(status);
          pinStatus = rejected
            ? Status.FAILED
            : dispatched && status !== 429
              ? Status.AMBIGUOUS
              : attempt >= MAX_PIN_ATTEMPTS
                ? Status.FAILED
                : Status.PENDING;
          if (pinStatus === Status.PENDING) {
            pinNextAt = new Date(Date.now() + Math.min(3_600_000, 30_000 * 2 ** (attempt - 1)));
          }
        }
        await persist({
          pinStatus,
          pinError:
            pinStatus === Status.DONE
              ? null
              : pinStatus === Status.PENDING
                ? 'Закрепление отложено. Повторим автоматически.'
                : pinStatus === Status.FAILED
                  ? 'Не удалось закрепить пост. Проверьте права Публика в MAX.'
                  : PIN_UNCONFIRMED,
        });
      }
    }

    let nextAt: Date | null = deleteStatus === Status.PENDING ? deleteAt : null;
    if (pinNextAt && (!nextAt || pinNextAt < nextAt)) nextAt = pinNextAt;
    if (
      deleteAt &&
      deleteAt.getTime() <= Date.now() &&
      (deleteStatus === Status.PENDING || deleteStatus === Status.RUNNING)
    ) {
      const attempt = row.deleteAttemptCount + 1;
      let deleted = false;
      try {
        await guard();
        await persist({ deleteStatus: Status.RUNNING, deleteAttemptCount: attempt });
        // FLAG: Author-scheduled deletion makes absence expected. Disarm pending verification
        // before HTTP; its old CAS cannot demote this delivery. Preserve completed verification.
        await this.prisma.managedBroadcastDelivery.updateMany({
          where: {
            id: row.id,
            postActionsToken: token,
            status: 'SENT',
            remoteMessageVerifiedAt: null,
          },
          data: PUBLICATION_DELIVERY_VERIFICATION_RESET_DATA,
        });
        try {
          await this.max.deleteMessage(row.targetChatId, row.remoteMessageId, {
            ...options,
            immediate: true,
            idempotencyKey: `publication-auto-delete:${row.id}`,
            beforeImmediateDeleteMutation: guard,
          });
          deleted = true;
        } catch {
          // FLAG: Only exact-message absence can replace documented delete success, never a bare 404.
          deleted =
            (await this.max.getExactMessagePresence(
              row.targetChatId,
              row.remoteMessageId,
              options,
            )) === 'absent';
        }
      } catch {
        deleted = false;
      }
      deleteStatus = deleted
        ? Status.DONE
        : attempt >= MAX_DELETE_ATTEMPTS
          ? Status.FAILED
          : Status.PENDING;
      nextAt =
        deleteStatus === Status.PENDING
          ? new Date(Date.now() + Math.min(3_600_000, 30_000 * 2 ** (attempt - 1)))
          : null;
      await persist({
        deleteStatus,
        deleteAttemptCount: attempt,
        deletedAt: deleted ? new Date() : null,
        deleteError: deleted
          ? null
          : deleteStatus === Status.FAILED
            ? 'Не удалось удалить пост. Проверьте права Публика и сообщение в MAX.'
            : 'Удаление не подтверждено. Повторим автоматически.',
      });
    }
    await persist({ postActionsNextAt: nextAt, postActionsToken: null });
  }

  private trigger(): void {
    if (this.closing || this.inFlight) return;
    this.inFlight = this.processDue()
      .catch(() => {
        this.logger.warn('Publication post-action sweep deferred');
      })
      .finally(() => {
        this.inFlight = null;
      });
  }
}
