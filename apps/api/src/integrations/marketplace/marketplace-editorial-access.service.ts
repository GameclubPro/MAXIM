import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  marketplaceEditorialProofInputSchema,
  marketplaceEditorialProofSchema,
  type MarketplaceEditorialProof,
  type MarketplaceEditorialProofInput,
} from '@maxim/contracts/marketplace-integration';
import { MarketplaceAccessService } from './marketplace-access.service';
import { MarketplaceProfileAccessService } from './marketplace-profile-access.service';
import { MarketplaceStateService, type MarketplaceBindingRow } from './marketplace-state.service';

@Injectable()
export class MarketplaceEditorialAccessService {
  constructor(
    private readonly state: MarketplaceStateService,
    private readonly access: MarketplaceAccessService,
    private readonly profileAccess: MarketplaceProfileAccessService,
  ) {}
  private matches(row: MarketplaceBindingRow, input: MarketplaceEditorialProofInput) {
    return (
      row.id === input.bindingId &&
      row.actor_user_id === input.actorUserId &&
      row.entity_id === input.entityId &&
      row.kind === input.kind &&
      row.profile === input.profile
    );
  }
  async prove(raw: unknown): Promise<MarketplaceEditorialProof> {
    const input = marketplaceEditorialProofInputSchema.parse(raw);
    const original = await this.state.read(input.bindingId);
    if (!original || !this.matches(original, input)) throw new NotFoundException();
    const started = new Date();
    let denied = false,
      succeeded = false;
    try {
      const result = await this.access.attest(
        {
          actorUserId: input.actorUserId,
          entityId: input.entityId,
          kind: input.kind,
          profile: input.profile,
        },
        false,
        false,
        'PROFILE_DESCRIPTION',
      );
      succeeded = this.matches(result, input);
    } catch (error) {
      denied = error instanceof ForbiddenException;
    }
    const current = await this.state.read(input.bindingId);
    if (!current || !this.matches(current, input)) throw new NotFoundException();
    // FLAG: Fresh MAX evidence never bypasses a newer persisted exact-user/bot denial.
    // This is a bounded proof, not an atomic cross-service revocation guarantee.
    const loss = await this.profileAccess.knownDenial(current);
    const base = { ...input, bindingRevision: current.revision };
    if (loss || denied)
      return marketplaceEditorialProofSchema.parse({
        ...base,
        state: 'REVOKED',
        checkedAt: (loss ?? started).toISOString(),
        validUntil: null,
      });
    const now = Date.now();
    const checked = current.checked_at?.getTime();
    const until =
      checked === undefined || !current.valid_until
        ? 0
        : Math.min(current.valid_until.getTime(), checked + 30_000);
    if (
      !succeeded ||
      current.state !== 'ACTIVE' ||
      checked === undefined ||
      checked > now + 1000 ||
      now - checked > 30_000 ||
      until <= now ||
      !(await this.state.hasActiveAccess(current.id))
    )
      return marketplaceEditorialProofSchema.parse({
        ...base,
        state: 'UNKNOWN',
        checkedAt: null,
        validUntil: null,
      });
    const final = await this.state.read(input.bindingId);
    if (!final || !this.matches(final, input)) throw new NotFoundException();
    const finalLoss = await this.profileAccess.knownDenial(final);
    if (finalLoss)
      return marketplaceEditorialProofSchema.parse({
        ...base,
        bindingRevision: final.revision,
        state: 'REVOKED',
        checkedAt: finalLoss.toISOString(),
        validUntil: null,
      });
    if (final.revision !== current.revision || final.state !== 'ACTIVE' || until <= Date.now())
      return marketplaceEditorialProofSchema.parse({
        ...base,
        bindingRevision: final.revision,
        state: 'UNKNOWN',
        checkedAt: null,
        validUntil: null,
      });
    return marketplaceEditorialProofSchema.parse({
      ...base,
      state: 'ACTIVE',
      checkedAt: current.checked_at!.toISOString(),
      validUntil: new Date(until).toISOString(),
    });
  }
}
