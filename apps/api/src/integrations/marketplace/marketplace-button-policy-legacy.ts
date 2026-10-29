import { createHash, randomUUID } from 'node:crypto';
import { marketplaceProfileRelayResponseSchema } from '@maxim/contracts/marketplace-integration';
import type { PrismaClient } from '../../prisma/prisma-client';
import type { MarketplaceBindingRow } from './marketplace-state.service';

/** Compatibility for an already-open old miniapp: its off switch still wins. */
export async function mirrorLegacyPublicationToggle(
  tx: Pick<PrismaClient, '$queryRaw' | '$executeRaw'>,
  binding: MarketplaceBindingRow,
  enabled: boolean,
): Promise<void> {
  const snapshot = marketplaceProfileRelayResponseSchema.safeParse(binding.profile_snapshot);
  const listingId = snapshot.success ? (snapshot.data.listing?.id ?? null) : null;
  const ownershipKey = listingId
    ? createHash('sha256')
        .update(`birzhik-owner-v1:${listingId}:${binding.actor_user_id}`)
        .digest('hex')
    : null;
  await tx.$executeRaw`INSERT INTO marketplace_button_policies(id,entity_id,kind,profile) VALUES(${randomUUID()}::uuid,${binding.entity_id},${binding.kind},${binding.profile}) ON CONFLICT(entity_id,kind,profile) DO NOTHING`;
  const rows = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT id FROM marketplace_button_policies WHERE entity_id=${binding.entity_id} AND kind=${binding.kind} AND profile=${binding.profile} FOR UPDATE`;
  const id = rows[0]!.id;
  const children = await tx.$queryRaw<Array<{ present: boolean }>>`
    SELECT EXISTS(SELECT 1 FROM marketplace_button_contexts WHERE policy_id=${id}::uuid
      AND context IN ('PUBLICATION','VK_IMPORT','APPROVED_SUGGESTION')) present`;
  const targets = children[0]!.present
    ? ['PUBLICATION', 'VK_IMPORT', 'APPROVED_SUGGESTION']
    : ['PUBLICATIONS'];
  // FLAG: Retire the rollback aggregate before a deliberate old-client group
  // choice updates every child. The off trigger must run before those writes.
  if (children[0]!.present)
    await tx.$executeRaw`UPDATE marketplace_button_contexts SET enabled=false WHERE policy_id=${id}::uuid AND context='PUBLICATIONS'`;
  // FLAG: Historical publication consent never enables greetings, notices or
  // post decoration. A fresh peer check establishes the opaque ownership key.
  for (const context of targets)
    await tx.$executeRaw`INSERT INTO marketplace_button_contexts(policy_id,profile,context,enabled,confirmed_by,confirmed_at,listing_id,ownership_key,binding_id,refresh_at)
    VALUES(${id}::uuid,${binding.profile},${context},${enabled},${binding.actor_user_id},now(),${listingId}::uuid,${ownershipKey},${binding.id}::uuid,now())
    ON CONFLICT(policy_id,context) DO UPDATE SET enabled=EXCLUDED.enabled,confirmed_by=EXCLUDED.confirmed_by,confirmed_at=EXCLUDED.confirmed_at,
      listing_id=EXCLUDED.listing_id,binding_id=EXCLUDED.binding_id,ownership_key=EXCLUDED.ownership_key,public_url=NULL,verified_until=NULL,
      refresh_at=now(),lease_id=NULL,lease_until=NULL,suspended_reason=NULL,diagnostic=NULL`;
  await tx.$executeRaw`UPDATE marketplace_button_policies SET revision=revision+1,updated_at=now() WHERE id=${id}::uuid`;
}
