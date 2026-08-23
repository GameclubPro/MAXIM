import { NestFactory } from '@nestjs/core';
import { maxUpdateSchema, type MaxUpdate } from '@maxim/contracts';
import type { KaravanStorefrontRelayResult } from '../integrations/karavan-storefront/karavan-storefront-relay.service';
import type { PrismaService } from '../prisma/prisma.service';
import { WebhookStatus } from '../prisma/prisma-client';

const KARAVAN_STOREFRONT_RELAY_AUDIT_ACTION = 'KARAVAN_STOREFRONT_RELAY';

export type CliOptions = {
  webhookEventIds: string[];
  apply: boolean;
  json: boolean;
};

type StoredWebhookEvent = {
  id: string;
  status: WebhookStatus;
  normalizedPayload: unknown;
};

export type RelayReplayCandidate = {
  webhookEventId: string;
  update: MaxUpdate;
  chatId: string;
  messageId: string;
  senderId: string;
  botId: string | null;
};

export type ReplayDecision =
  | {
      kind: 'eligible';
      candidate: RelayReplayCandidate;
    }
  | {
      kind: 'skipped';
      webhookEventId: string;
      reason: string;
    };

type RepairOutcome = {
  webhookEventId: string;
  chatId: string;
  messageId: string;
  result: KaravanStorefrontRelayResult | 'already_audited' | 'exception';
  error?: string;
};

export function readCliOptions(argv: readonly string[]): CliOptions {
  const webhookEventIds: string[] = [];
  let apply = false;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--webhook-event-id') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--webhook-event-id requires a value');
      }
      webhookEventIds.push(value.trim());
      index += 1;
      continue;
    }
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (webhookEventIds.length === 0) {
    throw new Error('At least one --webhook-event-id is required');
  }
  if (webhookEventIds.some((eventId) => eventId.length === 0)) {
    throw new Error('--webhook-event-id must not be blank');
  }
  if (new Set(webhookEventIds).size !== webhookEventIds.length) {
    throw new Error('Each --webhook-event-id must be unique');
  }

  return { webhookEventIds, apply, json };
}

export function classifyReplayEvent(event: StoredWebhookEvent): ReplayDecision {
  if (event.status !== WebhookStatus.PROCESSED) {
    return skip(event.id, `webhook_status_${event.status.toLowerCase()}`);
  }

  const parsed = maxUpdateSchema.safeParse(event.normalizedPayload);
  if (!parsed.success) {
    return skip(event.id, 'invalid_normalized_payload');
  }

  const update = parsed.data;
  const message = update.message;
  if (update.type !== 'message_created') {
    return skip(event.id, 'not_message_created');
  }

  const chatId = readString(message?.chatId);
  const messageId = readString(message?.messageId);
  const senderId = readString(message?.senderId);
  if (!chatId || !messageId || !senderId) {
    return skip(event.id, 'missing_message_identity');
  }
  if (/^\d+$/u.test(chatId)) {
    return skip(event.id, 'private_direct_chat');
  }

  const raw = asRecord(update.raw);
  const rawMessage = extractRawMessage(raw);
  if (!rawMessage) {
    return skip(event.id, 'missing_raw_message');
  }

  // The current relay handles an exact bare `$` from a direct message as the
  // storefront-directory onboarding action. Keep the legacy replay guard for
  // forwarded posts below: a non-empty outer body is still not replay-safe.
  const directText = extractMessageText(rawMessage) ?? readString(raw?.text);
  if (directText) {
    if (directText.trim() !== '$') {
      return skip(event.id, 'direct_text_present');
    }

    return eligibleCandidate({
      event,
      update,
      chatId,
      messageId,
      senderId,
    });
  }

  const link = asRecord(rawMessage.link);
  if (readLowerString(link?.type) !== 'forward') {
    return skip(event.id, 'not_forward');
  }

  const forwardSenderId = extractForwardSenderId(link);
  if (forwardSenderId && forwardSenderId !== senderId) {
    return skip(event.id, 'forward_sender_mismatch');
  }

  const forwardedText = extractMessageText(asRecord(link?.message));
  if (!forwardedText?.startsWith('$')) {
    return skip(event.id, 'missing_forwarded_dollar_marker');
  }

  return eligibleCandidate({
    event,
    update,
    chatId,
    messageId,
    senderId,
  });
}

function eligibleCandidate(params: {
  event: StoredWebhookEvent;
  update: MaxUpdate;
  chatId: string;
  messageId: string;
  senderId: string;
}): ReplayDecision {
  return {
    kind: 'eligible',
    candidate: {
      webhookEventId: params.event.id,
      update: params.update,
      chatId: params.chatId,
      messageId: params.messageId,
      senderId: params.senderId,
      botId: readString(params.update.botId),
    },
  };
}

function skip(webhookEventId: string, reason: string): ReplayDecision {
  return { kind: 'skipped', webhookEventId, reason };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractRawMessage(raw: Record<string, unknown> | null): Record<string, unknown> | null {
  const directMessage = asRecord(raw?.message);
  if (directMessage) {
    return directMessage;
  }

  const envelopeKeys = ['message_created', 'data', 'event'];
  for (const typeKey of [raw?.update_type, raw?.type]) {
    if (typeof typeKey === 'string' && typeKey.trim()) {
      envelopeKeys.push(typeKey);
    }
  }

  for (const key of envelopeKeys) {
    const envelope = asRecord(raw?.[key]);
    if (!envelope) {
      continue;
    }

    const nestedMessage = asRecord(envelope.message);
    if (nestedMessage) {
      return nestedMessage;
    }

    const nestedData = asRecord(envelope.data);
    const nestedDataMessage = asRecord(nestedData?.message);
    if (nestedDataMessage) {
      return nestedDataMessage;
    }
  }

  return null;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function readLowerString(value: unknown): string | null {
  return readString(value)?.toLowerCase() ?? null;
}

function extractMessageText(message: Record<string, unknown> | null): string | null {
  const body = asRecord(message?.body);
  const candidates = [
    body?.text,
    body?.caption,
    body?.plain,
    message?.text,
    message?.caption,
    message?.plain,
    message?.message_text,
    message?.messageText,
  ];

  for (const candidate of candidates) {
    const text = readString(candidate);
    if (text) {
      return text;
    }
  }

  return null;
}

function extractForwardSenderId(link: Record<string, unknown> | null): string | null {
  const sender = asRecord(link?.sender);
  return readString(
    link?.sender_id ?? link?.senderId ?? sender?.user_id ?? sender?.userId ?? sender?.id,
  );
}

async function hasRelayAudit(
  prisma: PrismaService,
  candidate: RelayReplayCandidate,
): Promise<boolean> {
  const audit = await prisma.auditLog.findFirst({
    where: {
      chatId: candidate.chatId,
      action: KARAVAN_STOREFRONT_RELAY_AUDIT_ACTION,
      payload: {
        path: ['sourceMessageId'],
        equals: candidate.messageId,
      },
    },
    select: { id: true },
  });

  return Boolean(audit);
}

function renderCandidate(candidate: RelayReplayCandidate): Record<string, string | null> {
  return {
    webhookEventId: candidate.webhookEventId,
    chatId: candidate.chatId,
    messageId: candidate.messageId,
    senderId: candidate.senderId,
    botId: candidate.botId,
  };
}

function printResult(result: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(result);
}

async function main(): Promise<void> {
  const options = readCliOptions(process.argv.slice(2));
  const [
    { KaravanStorefrontRelayRepairModule },
    { KaravanStorefrontRelayService },
    { PrismaService },
  ] = await Promise.all([
    import('./karavan-storefront-relay-repair.module'),
    import('../integrations/karavan-storefront/karavan-storefront-relay.service'),
    import('../prisma/prisma.service'),
  ]);
  const app = await NestFactory.createApplicationContext(KaravanStorefrontRelayRepairModule);

  try {
    const prisma = app.get(PrismaService);
    const relay = app.get(KaravanStorefrontRelayService);
    const storedEvents = await prisma.webhookEvent.findMany({
      where: {
        id: {
          in: options.webhookEventIds,
        },
      },
      select: {
        id: true,
        status: true,
        normalizedPayload: true,
      },
    });
    const eventsById = new Map(storedEvents.map((event) => [event.id, event]));
    const decisions = options.webhookEventIds.map((webhookEventId) => {
      const event = eventsById.get(webhookEventId);
      return event ? classifyReplayEvent(event) : skip(webhookEventId, 'webhook_event_not_found');
    });
    const skipped = decisions.filter(
      (decision): decision is Extract<ReplayDecision, { kind: 'skipped' }> =>
        decision.kind === 'skipped',
    );
    const eligible: RelayReplayCandidate[] = [];
    const alreadyAudited: RelayReplayCandidate[] = [];

    for (const decision of decisions) {
      if (decision.kind !== 'eligible') {
        continue;
      }

      if (await hasRelayAudit(prisma, decision.candidate)) {
        alreadyAudited.push(decision.candidate);
      } else {
        eligible.push(decision.candidate);
      }
    }

    const summary = {
      apply: options.apply,
      requestedWebhookEventIds: options.webhookEventIds,
      foundWebhookEvents: storedEvents.length,
      eligible: eligible.map(renderCandidate),
      alreadyAudited: alreadyAudited.map(renderCandidate),
      skipped,
    };

    if (!options.apply || eligible.length === 0) {
      printResult(summary, options.json);
      return;
    }

    const outcomes: RepairOutcome[] = [];
    for (const candidate of eligible) {
      if (await hasRelayAudit(prisma, candidate)) {
        outcomes.push({
          webhookEventId: candidate.webhookEventId,
          chatId: candidate.chatId,
          messageId: candidate.messageId,
          result: 'already_audited',
        });
        continue;
      }

      try {
        const settings = await prisma.chatSettings.findUnique({
          where: { chatId: candidate.chatId },
          select: { karavanStorefrontEnabled: true },
        });
        const result = await relay.handleMessageCreated({
          karavanStorefrontEnabled: settings?.karavanStorefrontEnabled ?? true,
          updateType: candidate.update.type,
          chatId: candidate.chatId,
          messageId: candidate.messageId,
          senderId: candidate.senderId,
          senderName: candidate.update.message?.senderName ?? null,
          text: candidate.update.message?.text ?? null,
          raw: candidate.update.raw,
          botId: candidate.botId,
        });
        outcomes.push({
          webhookEventId: candidate.webhookEventId,
          chatId: candidate.chatId,
          messageId: candidate.messageId,
          result,
        });
      } catch (error: unknown) {
        outcomes.push({
          webhookEventId: candidate.webhookEventId,
          chatId: candidate.chatId,
          messageId: candidate.messageId,
          result: 'exception',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const result = { ...summary, outcomes };
    printResult(result, options.json);
    if (outcomes.some((outcome) => outcome.result === 'failed' || outcome.result === 'exception')) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  });
}
