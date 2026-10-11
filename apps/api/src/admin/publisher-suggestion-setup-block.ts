import { ServiceUnavailableException } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { PublisherSetupRequiredException } from '../publisher/publisher-errors';
import type { PublisherReadinessService } from '../publisher/publisher-readiness.service';

const BLOCK_KEY = 'publisherAdminDeliverySetupBlock';
const isPermanentSetupBlock = (code: string) =>
  code === 'module_disabled' || code === 'write_permission_missing';

// FLAG: Call only at the initial readiness boundary, before claims or MAX sends. A
// later exception (including the same typed error) cannot establish absent effects.
export async function assertPublisherSuggestionDeliveryReady(params: {
  prisma: PrismaService;
  readiness: PublisherReadinessService | undefined;
  auditLogId: string;
  chatId: string;
  requiredBotId: string | null;
  setupBlockPresent: boolean;
}): Promise<void> {
  let route;
  try {
    route = await params.readiness?.assertEntityReady(params.chatId, 'suggestion_publish');
  } catch (error: unknown) {
    if (
      !(error instanceof PublisherSetupRequiredException) ||
      !isPermanentSetupBlock(error.blockerCode)
    )
      throw error;
    const block = JSON.stringify({
      version: 1,
      botId: params.requiredBotId,
      code: error.blockerCode,
    });
    // FLAG: Patch only our marker; concurrent reviews and per-recipient receipts remain
    // authoritative. A failed write must retain normal retry, never silently lose work.
    await params.prisma.$executeRaw(Prisma.sql`
      UPDATE audit_logs
      SET payload = payload::jsonb || jsonb_build_object(${BLOCK_KEY}::text, ${block}::jsonb)
      WHERE id = ${params.auditLogId} AND chat_id = ${params.chatId}
        AND action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'
        AND payload->>'type' = 'suggest' AND payload->>'reviewStatus' = 'pending'
        AND payload->>${BLOCK_KEY} IS DISTINCT FROM ${block}::jsonb::text
    `);
    throw new UnrecoverableError(`Publisher suggestion setup blocked: ${error.blockerCode}`);
  }
  if (!route || route.requiredBotId !== params.requiredBotId) {
    throw new ServiceUnavailableException('Publisher suggestion delivery route is unavailable');
  }
  if (!params.setupBlockPresent) return;
  await params.prisma.$executeRaw(Prisma.sql`
    UPDATE audit_logs SET payload = payload::jsonb - ${BLOCK_KEY}::text
    WHERE id = ${params.auditLogId} AND action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'
      AND payload->${BLOCK_KEY}->>'botId' = ${params.requiredBotId}
  `);
}

export async function canRecoverPublisherSuggestionDelivery(params: {
  prisma: PrismaService;
  readiness: PublisherReadinessService;
  auditLogId: string;
  requiredBotId: string;
}): Promise<boolean> {
  // FLAG: One primary-key read after the bounded recovery page, never a JSON filter
  // over retained history. Skipped rows still advance the caller's raw page cursor.
  const row = await params.prisma.auditLog.findUnique({
    where: { id: params.auditLogId },
    select: { chatId: true, action: true, payload: true },
  });
  if (!row || row.action !== 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION') return false;
  const payload = row.payload as Record<string, unknown> | null;
  if (!payload || payload.reviewStatus !== 'pending') return false;
  const block = payload[BLOCK_KEY];
  if (!block) return true;
  if (typeof block !== 'object' || Array.isArray(block)) return false;
  const marker = block as Record<string, unknown>;
  if (
    marker.version !== 1 ||
    marker.botId !== params.requiredBotId ||
    typeof marker.code !== 'string' ||
    !isPermanentSetupBlock(marker.code)
  )
    return false;
  try {
    const route = await params.readiness.assertEntityReady(row.chatId, 'suggestion_publish');
    return route.requiredBotId === params.requiredBotId;
  } catch (error: unknown) {
    if (error instanceof PublisherSetupRequiredException) return false;
    throw error;
  }
}
