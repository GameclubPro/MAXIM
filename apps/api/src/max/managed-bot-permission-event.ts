import { publisherAccessProbeLifecycleSuperseded } from '../publisher/publisher-access-probe-fence';
import type { MaxUpdate } from '@maxim/contracts';
import { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { readWebhookEventTimestamp } from '../webhook/webhook-semantic-event-key';
import type { MaxBotRegistryService } from './max-bot-registry.service';
import type { MaxBotLinkService } from './max-bot-link.service';
import { buildBotAccessSnapshotPersistence } from './bot-access-snapshot.util';
import { isPublisherManagedEntityActivationRequired } from '../publisher/publisher-entity-connection.util';

export const BOT_PERMISSION_CHANGE_UPDATE = 'bot_admin_permissions_changed';

export async function applyManagedBotPermissionEvent(params: {
  update: MaxUpdate;
  prisma: PrismaService;
  registry: MaxBotRegistryService;
  links: MaxBotLinkService;
}): Promise<void> {
  const { update, prisma, registry, links } = params;
  const raw = update.raw;
  const at = readWebhookEventTimestamp(update);
  const botId = update.botId;
  const chatId = update.message?.chatId;
  if (
    update.type !== BOT_PERMISSION_CHANGE_UPDATE ||
    !raw ||
    !at ||
    at.getTime() > Date.now() ||
    !botId ||
    !chatId ||
    typeof raw.is_admin !== 'boolean' ||
    typeof raw.is_channel !== 'boolean'
  )
    return;
  const publisher = registry.getPublisherBotDescriptor();
  const targetId =
    typeof raw.bot_id === 'number' && Number.isSafeInteger(raw.bot_id)
      ? String(raw.bot_id)
      : typeof raw.bot_id === 'string'
        ? raw.bot_id
        : null;
  // FLAG: The actor user_id is never the affected bot. Bind the documented bot_id
  // to the authenticated receiving token; a peer's event cannot modify this connection.
  if (
    !targetId ||
    (botId === publisher.id
      ? targetId !== publisher.contactId
      : registry.resolveBotIdFromUserId(targetId) !== botId)
  )
    return;
  const permissionsKnown =
    Array.isArray(raw.permissions) && raw.permissions.every((p) => typeof p === 'string');
  if (raw.is_admin && !permissionsKnown) return;
  const access = {
    isAdmin: raw.is_admin,
    isOwner: false,
    permissions: permissionsKnown ? (raw.permissions as string[]) : [],
    permissionsKnown,
    explicitPrivilegeEvidence: true,
  };
  const source = 'webhook_bot_admin_permissions_changed';
  if (botId !== publisher.id) {
    await links.recordBotAccessProbe({ chatId, botId, access, source, checkedAt: at });
    return;
  }
  await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM chats WHERE id = ${chatId} FOR UPDATE`);
    if (locked.length !== 1) return;
    const binding = await tx.publisherEntityBinding.findUnique({ where: { chatId } });
    if (
      !binding ||
      binding.publisherBotId !== botId ||
      binding.status !== 'ACTIVE' ||
      (binding.botAccessCheckedAt &&
        (binding.botAccessCheckedAt > at ||
          (binding.botAccessCheckedAt.getTime() === at.getTime() && access.isAdmin))) ||
      publisherAccessProbeLifecycleSuperseded(binding, at) ||
      (access.isAdmin && isPublisherManagedEntityActivationRequired(binding))
    )
      return;
    await tx.publisherEntityBinding.update({
      where: { chatId },
      data: {
        ...buildBotAccessSnapshotPersistence(access, { source, now: at }),
        capabilities: access.permissions,
        lifecycleEventAt: at,
        lifecycleEventType: BOT_PERMISSION_CHANGE_UPDATE,
      },
    });
  });
}
