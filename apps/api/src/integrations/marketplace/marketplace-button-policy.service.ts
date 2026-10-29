import {
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import {
  marketplaceBindingInputSchema,
  marketplaceButtonModules,
  MARKETPLACE_BUTTON_DEFAULT_CAPTION,
  type MarketplaceButtonModule,
  marketplaceButtonPolicyMutationSchema,
  marketplaceButtonPolicyStateSchema,
  marketplaceEntryResponseSchema,
  type MarketplaceBindingInput,
  type MarketplaceButtonContext,
  type MarketplaceButtonPolicyState,
  type MarketplaceEntryResponse,
} from '@maxim/contracts/marketplace-integration';
import { type PrismaClient } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { MarketplaceAccessService } from './marketplace-access.service';
import { readMarketplaceResponse } from './marketplace-profile.service';
import {
  MarketplaceStateService,
  marketplaceLocalGrantSql,
  type MarketplaceBindingRow,
} from './marketplace-state.service';

type Sql = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;
export type MarketplaceButtonPolicyRow = {
  id: string;
  entity_id: string;
  kind: 'CHAT' | 'CHANNEL';
  profile: 'moderation' | 'publisher';
  revision: number;
};
export type MarketplaceButtonContextRow = {
  policy_id: string;
  context: MarketplaceButtonContext | MarketplaceButtonModule;
  enabled: boolean;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  listing_id: string | null;
  ownership_key: string | null;
  binding_id: string | null;
  verified_until: Date | null;
  public_url: string | null;
  suspended_reason: string | null;
  diagnostic: string | null;
  refresh_at: Date;
  lease_id: string | null;
  lease_until: Date | null;
};
type RefreshRow = MarketplaceButtonContextRow & Omit<MarketplaceButtonPolicyRow, 'id'>;
const ENTRY_URL = 'https://major-maksimov.ru/market/api/integrations/maxim/v1/entry';
const BOT = 'https://max.ru/id613000037577_3_bot';
export function marketplaceButtonContexts(
  input: Pick<MarketplaceBindingInput, 'profile' | 'kind'>,
): MarketplaceButtonContext[] {
  return input.profile === 'publisher'
    ? ['PUBLICATIONS']
    : input.kind === 'CHANNEL'
      ? ['CHANNEL_POSTS']
      : ['GREETINGS', 'MODERATION_NOTICES'];
}

@Injectable()
export class MarketplaceButtonPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly state: MarketplaceStateService,
    private readonly access: MarketplaceAccessService,
  ) {}
  identity(
    userId: string,
    kind: unknown,
    entityId: unknown,
    profile: unknown,
  ): MarketplaceBindingInput {
    return marketplaceBindingInputSchema.parse({ actorUserId: userId, kind, entityId, profile });
  }
  private async authorize(input: MarketplaceBindingInput): Promise<MarketplaceBindingRow> {
    if (!this.state.enabled()) throw new ServiceUnavailableException('Биржик пока не подключён');
    const rows = await this.prisma.$queryRaw<
      MarketplaceBindingRow[]
    >`SELECT * FROM marketplace_bindings
      WHERE actor_user_id=${input.actorUserId} AND entity_id=${input.entityId} AND kind=${input.kind} AND profile=${input.profile}
      AND checked_at>now()-interval '5 minutes' AND ${marketplaceLocalGrantSql('marketplace_bindings', false)}`;
    return rows[0] ?? this.access.attest(input);
  }
  async entry(input: MarketplaceBindingInput): Promise<MarketplaceEntryResponse> {
    await this.authorize(input);
    return this.readEntry(input);
  }
  async readEntry(input: MarketplaceBindingInput): Promise<MarketplaceEntryResponse> {
    const token = this.config.get<string>('SVYAZKA_PROFILE_TOKEN');
    if (!token) throw new ServiceUnavailableException('Биржик пока не подключён');
    const url = new URL(ENTRY_URL);
    for (const [key, value] of Object.entries(input)) url.searchParams.set(key, value);
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
      const entry = marketplaceEntryResponseSchema.parse(await readMarketplaceResponse(response));
      const kind = input.kind === 'CHANNEL' ? 'channel' : 'chat';
      if (
        entry.entityId !== input.entityId ||
        entry.kind !== input.kind ||
        entry.profile !== input.profile ||
        entry.connectUrl !== `${BOT}?startapp=connect_${kind}_${input.entityId}` ||
        (entry.manageUrl !== null &&
          (!entry.isOwner ||
            entry.manageUrl !== `${BOT}?startapp=manage_${kind}_${entry.listing?.id}`)) ||
        (entry.listing?.publicUrl != null &&
          entry.listing.publicUrl !== `${BOT}?startapp=listing_${kind}_${entry.listing.id}`) ||
        Date.parse(entry.checkedAt) > Date.now() + 30_000 ||
        (entry.validUntil !== null &&
          (Date.parse(entry.validUntil) > Date.parse(entry.checkedAt) + 300_000 ||
            Date.parse(entry.validUntil) > Date.now() + 330_000))
      )
        throw new Error('Marketplace entry identity mismatch');
      return entry;
    } catch {
      throw new ServiceUnavailableException('Не удалось проверить профиль в Биржике');
    }
  }
  async get(input: MarketplaceBindingInput): Promise<MarketplaceButtonPolicyState> {
    await this.authorize(input);
    await this.importLegacy(input);
    return this.present(this.prisma, input);
  }
  async mutate(
    input: MarketplaceBindingInput,
    raw: unknown,
  ): Promise<MarketplaceButtonPolicyState> {
    const command = marketplaceButtonPolicyMutationSchema.parse(raw);
    if ('context' in command && !marketplaceButtonContexts(input).includes(command.context)) {
      const legacy = await this.prisma.$queryRaw<
        Array<{ id: string }>
      >`SELECT p.id FROM marketplace_button_policies p JOIN marketplace_button_contexts c ON c.policy_id=p.id WHERE p.entity_id=${input.entityId} AND p.kind=${input.kind} AND p.profile=${input.profile} AND c.context='PUBLICATIONS'`;
      if (command.context !== 'PUBLICATIONS' || !legacy.length)
        throw new ForbiddenException('Это место показа недоступно для площадки');
    }
    const hash = createHash('sha256')
      .update(JSON.stringify({ ...input, ...command }))
      .digest('hex');
    const authorization = await this.authorize(input);
    const replay = await this.prisma.$queryRaw<
      Array<{ actor_user_id: string; payload_hash: string; result: unknown }>
    >`
      SELECT actor_user_id,payload_hash,result FROM marketplace_button_requests WHERE request_id=${command.requestId}::uuid`;
    if (replay[0]) return this.replay(replay[0], input.actorUserId, hash);
    // FLAG: Disabling does not depend on the peer. Enabling verifies the public
    // card and the confirmer's exact platform access without changing ownership.
    const enabling = 'enabled' in command && command.enabled;
    const binding = enabling ? await this.access.attest(input) : authorization;
    const entry = enabling ? await this.readEntry(input) : null;
    if (
      enabling &&
      (!entry?.listing?.publicUrl ||
        entry.publicState !== 'PUBLIC' ||
        !entry.validUntil ||
        Date.parse(entry.validUntil) <= Date.now())
    )
      throw new ConflictException('Сначала опубликуйте профиль площадки в Биржике');
    const started = new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM chats WHERE id=${input.entityId} FOR UPDATE`;
      // FLAG: Legacy receipt writers hold binding before policy. Preserve that
      // order so a concurrent old off switch cannot deadlock a canonical change.
      await tx.$queryRaw`SELECT id FROM marketplace_bindings WHERE entity_id=${input.entityId} AND profile=${input.profile} ORDER BY id FOR UPDATE`;
      await this.importLegacy(input, tx);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${command.requestId},0))::text`;
      await tx.$executeRaw`INSERT INTO marketplace_button_policies(id,entity_id,kind,profile) VALUES(${randomUUID()}::uuid,${input.entityId},${input.kind},${input.profile}) ON CONFLICT(entity_id,kind,profile) DO NOTHING`;
      const policies = await tx.$queryRaw<
        MarketplaceButtonPolicyRow[]
      >`SELECT * FROM marketplace_button_policies WHERE entity_id=${input.entityId} AND kind=${input.kind} AND profile=${input.profile} FOR UPDATE`;
      const policy = policies[0]!;
      const previous = await tx.$queryRaw<
        Array<{ actor_user_id: string; payload_hash: string; result: unknown }>
      >`SELECT actor_user_id,payload_hash,result FROM marketplace_button_requests WHERE request_id=${command.requestId}::uuid`;
      if (previous[0]) return this.replay(previous[0], input.actorUserId, hash);
      if ('expectedRevision' in command && policy.revision !== command.expectedRevision)
        throw new ConflictException('Настройки изменились. Обновите экран');
      const current = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM marketplace_bindings WHERE id=${binding.id}::uuid AND ${marketplaceLocalGrantSql('marketplace_bindings', false)}`;
      if (!current.length) throw new ConflictException('Права изменились. Обновите экран');
      if ('caption' in command) {
        const captions = await tx.$queryRaw<
          Array<{ revision: number }>
        >`SELECT revision FROM marketplace_button_captions WHERE entity_id=${input.entityId} AND kind=${input.kind}`;
        if ((captions[0]?.revision ?? 0) !== command.expectedCaptionRevision)
          throw new ConflictException('Текст изменил другой администратор. Обновите экран');
        await tx.$executeRaw`INSERT INTO marketplace_button_captions(entity_id,kind,caption,revision)
          VALUES(${input.entityId},${input.kind},${command.caption},1)
          ON CONFLICT(entity_id,kind) DO UPDATE SET caption=EXCLUDED.caption,revision=marketplace_button_captions.revision+1`;
      } else {
        const until =
          enabling && entry?.validUntil && binding.valid_until && binding.checked_at
            ? new Date(
                Math.min(
                  Date.parse(entry.validUntil),
                  binding.valid_until.getTime(),
                  binding.checked_at.getTime() + 300_000,
                  started.getTime() + 300_000,
                ),
              )
            : null;
        if (enabling && (!until || until.getTime() <= Date.now()))
          throw new ConflictException('Проверка профиля истекла. Повторите включение');
        const modules = marketplaceButtonModules[command.context];
        const grouped = modules.length > 1;
        if (grouped) await this.materializeModules(tx, policy.id, command.context);
        const targets = grouped ? (command.module ? [command.module] : modules) : [command.context];
        // Retire a legacy aggregate before changing children. Its off trigger is also
        // the rollback fence for a still-open old administrator screen.
        if (grouped && !command.module)
          await tx.$executeRaw`UPDATE marketplace_button_contexts SET enabled=false WHERE policy_id=${policy.id}::uuid AND context=${command.context}`;
        for (const context of targets) {
          await tx.$executeRaw`INSERT INTO marketplace_button_contexts(policy_id,profile,context,enabled,confirmed_by,confirmed_at,listing_id,ownership_key,binding_id,verified_until,public_url,refresh_at)
            VALUES(${policy.id}::uuid,${input.profile},${context},${command.enabled},${input.actorUserId},${started},${entry?.listing?.id ?? null}::uuid,${entry?.listing?.ownershipKey ?? null},${binding.id}::uuid,${until},${entry?.listing?.publicUrl ?? null},now()+interval '2 minutes')
            ON CONFLICT(policy_id,context) DO UPDATE SET enabled=EXCLUDED.enabled,confirmed_by=EXCLUDED.confirmed_by,confirmed_at=EXCLUDED.confirmed_at,
              listing_id=EXCLUDED.listing_id,ownership_key=EXCLUDED.ownership_key,binding_id=EXCLUDED.binding_id,verified_until=EXCLUDED.verified_until,public_url=EXCLUDED.public_url,
              refresh_at=EXCLUDED.refresh_at,lease_id=NULL,lease_until=NULL,suspended_reason=NULL,diagnostic=NULL`;
        }
        if (command.context === 'PUBLICATIONS') {
          await tx.$executeRaw`UPDATE marketplace_bindings SET append_enabled=false,append_revision=append_revision+1,revision=revision+1,updated_at=now() WHERE entity_id=${input.entityId} AND kind=${input.kind} AND profile=${input.profile} AND append_enabled=true`;
        }
        await tx.$executeRaw`UPDATE marketplace_button_policies SET revision=revision+1,updated_at=now() WHERE id=${policy.id}::uuid`;
      }
      const result = await this.present(tx, input);
      await tx.$executeRaw`INSERT INTO marketplace_button_requests(request_id,policy_id,actor_user_id,payload_hash,result) VALUES(${command.requestId}::uuid,${policy.id}::uuid,${input.actorUserId},${hash},${JSON.stringify(result)}::jsonb)`;
      return result;
    });
  }
  private async materializeModules(db: Sql, policyId: string, context: MarketplaceButtonContext) {
    const modules = marketplaceButtonModules[context];
    const existing = await db.$queryRaw<
      Array<{ context: string }>
    >`SELECT context FROM marketplace_button_contexts WHERE policy_id=${policyId}::uuid AND context=ANY(${[...modules]}::text[])`;
    if (existing.length) return;
    const legacy = await db.$queryRaw<
      MarketplaceButtonContextRow[]
    >`SELECT * FROM marketplace_button_contexts WHERE policy_id=${policyId}::uuid AND context=${context}`;
    const source = legacy[0];
    if (!source) return;
    // FLAG: Disable the legacy reader before copying its exact old scope. Newly
    // supported night/rules messages do not inherit historical moderation consent.
    await db.$executeRaw`UPDATE marketplace_button_contexts SET enabled=false WHERE policy_id=${policyId}::uuid AND context=${context}`;
    await db.$executeRaw`INSERT INTO marketplace_button_contexts(policy_id,profile,context,enabled,confirmed_by,confirmed_at,listing_id,ownership_key,binding_id,verified_until,public_url,refresh_at,suspended_reason)
      SELECT c.policy_id,c.profile,m.module,${source.enabled} AND m.module NOT IN ('NIGHT_MODE','RULES'),c.confirmed_by,c.confirmed_at,c.listing_id,c.ownership_key,c.binding_id,c.verified_until,c.public_url,c.refresh_at,c.suspended_reason
      FROM marketplace_button_contexts c CROSS JOIN unnest(${[...modules]}::text[]) m(module)
      WHERE c.policy_id=${policyId}::uuid AND c.context=${context} ON CONFLICT DO NOTHING`;
  }
  private replay(
    previous: { actor_user_id: string; payload_hash: string; result: unknown },
    actor: string,
    hash: string,
  ): MarketplaceButtonPolicyState {
    if (previous.actor_user_id !== actor || previous.payload_hash !== hash)
      throw new ConflictException('Идентификатор запроса уже использован');
    return marketplaceButtonPolicyStateSchema.parse(previous.result);
  }
  private async present(
    db: Sql,
    input: MarketplaceBindingInput,
  ): Promise<MarketplaceButtonPolicyState> {
    const rows = await db.$queryRaw<
      MarketplaceButtonPolicyRow[]
    >`SELECT * FROM marketplace_button_policies WHERE entity_id=${input.entityId} AND kind=${input.kind} AND profile=${input.profile}`;
    const policy = rows[0];
    const contexts = policy
      ? await db.$queryRaw<Array<MarketplaceButtonContextRow & { allowed: boolean }>>`SELECT c.*,
      (c.enabled AND c.suspended_reason IS NULL AND c.public_url IS NOT NULL AND c.verified_until>now() AND EXISTS(SELECT 1 FROM marketplace_bindings b WHERE b.id=c.binding_id AND b.checked_at>now()-interval '5 minutes' AND ${marketplaceLocalGrantSql('b', false)} AND (b.last_button_access_loss_at IS NULL OR b.last_button_access_loss_at<c.confirmed_at)
        AND NOT EXISTS(SELECT 1 FROM chat_membership_activity_events e WHERE e.chat_id=b.entity_id AND e.user_id=c.confirmed_by AND e.event_type='user_removed' AND e.event_at AT TIME ZONE 'UTC'>=c.confirmed_at))) allowed
      FROM marketplace_button_contexts c WHERE c.policy_id=${policy.id}::uuid`
      : [];
    const captions = await db.$queryRaw<
      Array<{ caption: string; revision: number }>
    >`SELECT caption,revision FROM marketplace_button_captions WHERE entity_id=${input.entityId} AND kind=${input.kind}`;
    return marketplaceButtonPolicyStateSchema.parse({
      caption: captions[0]?.caption ?? MARKETPLACE_BUTTON_DEFAULT_CAPTION,
      captionRevision: captions[0]?.revision ?? 0,
      entityId: input.entityId,
      kind: input.kind,
      profile: input.profile,
      revision: policy?.revision ?? 0,
      contexts: [
        ...marketplaceButtonContexts(input),
        ...(input.profile === 'moderation' && contexts.some((row) => row.context === 'PUBLICATIONS')
          ? ['PUBLICATIONS' as const]
          : []),
      ].map((context) => {
        const definitions = marketplaceButtonModules[context];
        const legacy = contexts.find((item) => item.context === context);
        const hasModules = definitions.some((module) =>
          contexts.some((item) => item.context === module),
        );
        const modules = definitions.map((module) => {
          const row = hasModules
            ? contexts.find((item) => item.context === module)
            : ['NIGHT_MODE', 'RULES'].includes(module)
              ? undefined
              : legacy;
          return {
            module,
            enabled: row?.enabled ?? false,
            effective: row?.allowed ?? false,
            needsConfirmation: !!row?.enabled && !!row.suspended_reason,
          };
        });
        const enabled = modules.some((item) => item.enabled);
        const effective = modules.some((item) => item.effective);
        const needsConfirmation = modules.some((item) => item.needsConfirmation);
        return {
          context,
          enabled,
          effective,
          modules,
          partial: enabled && modules.some((item) => !item.enabled),
          status: !enabled
            ? 'OFF'
            : needsConfirmation
              ? 'CONFIRM_REQUIRED'
              : effective
                ? 'READY'
                : contexts.some(
                      (row) =>
                        (row.context === context ||
                          definitions.includes(row.context as MarketplaceButtonModule)) &&
                        row.enabled &&
                        row.public_url,
                    )
                  ? 'CHECKING'
                  : 'PROFILE_UNAVAILABLE',
          enabledAt:
            contexts
              .find(
                (row) =>
                  (row.context === context ||
                    definitions.includes(row.context as MarketplaceButtonModule)) &&
                  row.enabled,
              )
              ?.confirmed_at?.toISOString() ?? null,
        };
      }),
      buttonDiagnostic: contexts.some((row) => row.diagnostic === 'KEYBOARD_FULL')
        ? 'KEYBOARD_FULL'
        : null,
    });
  }
  /** Bounded background refresh independent of CENTRAL statistics refresh. */
  async refresh(profile: 'moderation' | 'publisher', stopping: () => boolean): Promise<void> {
    const deadline = Date.now() + 20_000;
    await this.importLegacyBatch(profile);
    // FLAG: The cohort and wall-clock budgets are independent. Nominate only
    // immediately-started work, so unstarted rows keep their place in the queue.
    for (let index = 0; index < 80 && !stopping() && Date.now() < deadline; index++) {
      const lease = randomUUID();
      const rows = await this.prisma.$queryRaw<RefreshRow[]>`WITH due AS (
        SELECT c.policy_id,c.confirmed_by FROM marketplace_button_contexts c
        WHERE c.profile=${profile} AND c.enabled=true AND c.suspended_reason IS NULL AND c.refresh_at<=now() AND (c.lease_until IS NULL OR c.lease_until<now())
        ORDER BY c.refresh_at,c.policy_id,c.context FOR UPDATE SKIP LOCKED LIMIT 1
      ), cohort AS (SELECT c.policy_id,c.context FROM marketplace_button_contexts c JOIN due
        ON c.policy_id=due.policy_id AND c.confirmed_by IS NOT DISTINCT FROM due.confirmed_by
        WHERE c.enabled=true AND c.suspended_reason IS NULL AND (c.lease_until IS NULL OR c.lease_until<now())
        FOR UPDATE OF c SKIP LOCKED
      ), claimed AS (UPDATE marketplace_button_contexts c SET lease_id=${lease}::uuid,lease_until=now()+interval '30 seconds',refresh_at=now()+interval '1 minute'
        FROM cohort WHERE c.policy_id=cohort.policy_id AND c.context=cohort.context RETURNING c.*)
      SELECT c.*,p.entity_id,p.kind,p.profile,p.revision FROM claimed c JOIN marketplace_button_policies p ON p.id=c.policy_id`;
      const first = rows[0];
      if (!first) return;
      let proof:
        | Promise<{ binding: MarketplaceBindingRow; entry: MarketplaceEntryResponse }>
        | undefined;
      const loadProof = () => {
        if (!proof) {
          const input = this.identity(
            first.confirmed_by!,
            first.kind,
            first.entity_id,
            first.profile,
          );
          proof = this.access
            .attest(input, false, true)
            .then(async (binding) => ({ binding, entry: await this.readEntry(input) }));
        }
        return proof;
      };
      for (const row of rows) await this.refreshContext(row, lease, loadProof);
    }
  }
  private async refreshContext(
    row: RefreshRow,
    lease: string,
    loadProof: () => Promise<{ binding: MarketplaceBindingRow; entry: MarketplaceEntryResponse }>,
  ): Promise<void> {
    try {
      if (!row.confirmed_by || !row.confirmed_at || !row.binding_id) {
        await this.suspend(row, lease, 'ACCESS_LOST');
        return;
      }
      // FLAG: A later positive proof cannot revive consent after a known removal.
      const denial = await this.prisma.$queryRaw<Array<{ denied: boolean }>>`SELECT (
        EXISTS(SELECT 1 FROM chat_membership_activity_events e WHERE e.chat_id=${row.entity_id} AND e.user_id=${row.confirmed_by} AND e.event_type='user_removed' AND e.event_at AT TIME ZONE 'UTC'>=${row.confirmed_at})
        OR EXISTS(SELECT 1 FROM marketplace_bindings b WHERE b.id=${row.binding_id}::uuid AND (b.state='REVOKED' AND b.checked_at>=${row.confirmed_at} OR b.last_button_access_loss_at>=${row.confirmed_at}))
        OR EXISTS(SELECT 1 FROM managed_entity_access_edges a JOIN marketplace_bindings b ON b.id=${row.binding_id}::uuid AND a.bot_id=b.bot_id
          WHERE a.chat_id=${row.entity_id} AND a.user_id=${row.confirmed_by} AND a.checked_at AT TIME ZONE 'UTC'>=${row.confirmed_at} AND (a.state<>'GRANTED' OR a.user_role NOT IN ('OWNER','ADMIN')))) denied`;
      if (denial[0]?.denied) {
        await this.suspend(row, lease, 'ACCESS_LOST');
        return;
      }
      const { binding, entry } = await loadProof();
      if (
        entry.publicState === 'ABSENT' ||
        (entry.listing &&
          (entry.listing.id !== row.listing_id ||
            (row.ownership_key && entry.listing.ownershipKey !== row.ownership_key)))
      ) {
        await this.suspend(row, lease, 'PROFILE_CHANGED');
        return;
      }
      const until =
        entry.publicState === 'PUBLIC' &&
        entry.validUntil &&
        entry.listing?.publicUrl &&
        binding.valid_until &&
        binding.checked_at
          ? new Date(
              Math.min(
                Date.parse(entry.validUntil),
                binding.valid_until.getTime(),
                binding.checked_at.getTime() + 300_000,
                Date.now() + 300_000,
              ),
            )
          : null;
      await this.prisma
        .$executeRaw`UPDATE marketplace_button_contexts SET binding_id=${binding.id}::uuid,
        ownership_key=COALESCE(ownership_key,${entry.listing?.ownershipKey ?? null}),public_url=${until ? entry.listing!.publicUrl : null},verified_until=${until},
        refresh_at=now()+interval '2 minutes',lease_id=NULL,lease_until=NULL
        WHERE policy_id=${row.policy_id}::uuid AND context=${row.context} AND lease_id=${lease}::uuid AND enabled=true AND suspended_reason IS NULL
          AND EXISTS(SELECT 1 FROM marketplace_bindings b WHERE b.id=${binding.id}::uuid AND ${marketplaceLocalGrantSql('b', false)})`;
    } catch (error) {
      if (error instanceof ForbiddenException) await this.suspend(row, lease, 'ACCESS_LOST');
      else
        await this.prisma
          .$executeRaw`UPDATE marketplace_button_contexts SET lease_id=NULL,lease_until=NULL,refresh_at=now()+interval '1 minute' WHERE policy_id=${row.policy_id}::uuid AND context=${row.context} AND lease_id=${lease}::uuid`;
    }
  }
  private async suspend(
    row: RefreshRow,
    lease: string,
    reason: 'ACCESS_LOST' | 'PROFILE_CHANGED',
  ): Promise<void> {
    await this.prisma
      .$executeRaw`UPDATE marketplace_button_contexts SET suspended_reason=${reason},verified_until=NULL,public_url=NULL,lease_id=NULL,lease_until=NULL WHERE policy_id=${row.policy_id}::uuid AND context=${row.context} AND lease_id=${lease}::uuid`;
  }
  private async importLegacyBatch(profile: 'moderation' | 'publisher'): Promise<void> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        actor_user_id: string;
        entity_id: string;
        kind: 'CHAT' | 'CHANNEL';
        profile: 'moderation' | 'publisher';
      }>
    >`
      SELECT b.actor_user_id,b.entity_id,b.kind,b.profile FROM marketplace_bindings b
      WHERE b.profile=${profile} AND b.append_enabled=true AND b.statistics_consent=true AND b.statistics_revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM marketplace_button_policies p WHERE p.entity_id=b.entity_id AND p.kind=b.kind AND p.profile=b.profile)
      ORDER BY b.id LIMIT 5`;
    for (const row of rows)
      await this.importLegacy(
        this.identity(row.actor_user_id, row.kind, row.entity_id, row.profile),
      );
  }
  private async importLegacy(input: MarketplaceBindingInput, transaction?: Sql): Promise<void> {
    // FLAG: Existing append consent only covers publication intents. No old
    // setting enables moderation notices, greetings or channel post decoration.
    const importWithin = async (tx: Sql) => {
      const rows = await tx.$queryRaw<
        MarketplaceBindingRow[]
      >`SELECT b.* FROM marketplace_bindings b WHERE b.entity_id=${input.entityId} AND b.kind=${input.kind} AND b.profile=${input.profile} AND b.append_enabled=true AND b.statistics_consent=true AND b.statistics_revoked_at IS NULL ORDER BY b.updated_at DESC,b.id LIMIT 1`;
      const binding = rows[0];
      if (!binding) return;
      const inserted = await tx.$queryRaw<
        Array<{ id: string }>
      >`INSERT INTO marketplace_button_policies(id,entity_id,kind,profile) VALUES(${randomUUID()}::uuid,${input.entityId},${input.kind},${input.profile}) ON CONFLICT(entity_id,kind,profile) DO NOTHING RETURNING id`;
      if (!inserted[0]) return;
      const snapshot = z
        .object({ listing: z.object({ id: z.string().uuid() }).nullable() })
        .safeParse(binding.profile_snapshot);
      const listingId = snapshot.success ? (snapshot.data.listing?.id ?? null) : null;
      const ownershipKey = listingId
        ? createHash('sha256')
            .update(`birzhik-owner-v1:${listingId}:${binding.actor_user_id}`)
            .digest('hex')
        : null;
      await tx.$executeRaw`INSERT INTO marketplace_button_contexts(policy_id,profile,context,enabled,confirmed_by,confirmed_at,listing_id,ownership_key,binding_id,public_url,verified_until,refresh_at)
        VALUES(${inserted[0].id}::uuid,${input.profile},'PUBLICATIONS',true,${binding.actor_user_id},${binding.updated_at},${listingId}::uuid,${ownershipKey},${binding.id}::uuid,NULL,NULL,now())`;
    };
    if (transaction) await importWithin(transaction);
    else
      await this.prisma.$transaction(async (tx) => {
        // FLAG: The first import must wait for an old writer's off receipt before
        // reading its legacy flag; otherwise a stale true can recreate consent.
        await tx.$queryRaw`SELECT id FROM chats WHERE id=${input.entityId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM marketplace_bindings WHERE entity_id=${input.entityId} AND profile=${input.profile} ORDER BY id FOR UPDATE`;
        await importWithin(tx);
      });
  }
}
