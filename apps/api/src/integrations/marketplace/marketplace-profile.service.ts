import {
  ConflictException,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { mirrorLegacyPublicationToggle } from './marketplace-button-policy-legacy';
import { ConfigService } from '@nestjs/config';
import {
  marketplaceBindingInputSchema,
  marketplaceProfileMutationSchema,
  marketplaceProfileRelayResponseSchema,
  marketplaceProfileStatisticsSchema,
  marketplaceProfileStateSchema,
  type MarketplaceBindingInput,
  type MarketplaceProfileRelayResponse,
} from '@maxim/contracts/marketplace-integration';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma, type PrismaClient } from '../../prisma/prisma-client';
import { profileStatisticsSummary } from './marketplace-profile-statistics';
import { centralEnabled } from '../../statistics/stats-common';
import { StatsReadService } from '../../statistics/stats-read.service';
import { MarketplaceAccessService } from './marketplace-access.service';
import { MarketplaceStateService, type MarketplaceBindingRow } from './marketplace-state.service';

const PROFILE_URL = 'https://major-maksimov.ru/market/api/integrations/maxim/v1/profile';
const PUBLIC_BOT = 'https://max.ru/id613000037577_3_bot';
type ProfileSql = Pick<PrismaClient, '$queryRaw'>;
export async function readMarketplaceResponse(response: Response): Promise<unknown> {
  if (!response.ok || !response.body)
    throw new ServiceUnavailableException('Связка временно недоступна');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 128 * 1024) throw new ServiceUnavailableException('Ответ Связки слишком большой');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ServiceUnavailableException('Некорректный ответ Связки');
  }
}
@Injectable()
export class MarketplaceProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly state: MarketplaceStateService,
    private readonly access: MarketplaceAccessService,
    @Optional() private readonly centralStats?: StatsReadService,
  ) {}
  capability(userId: string) {
    return { available: /^[1-9]\d{0,19}$/u.test(userId) && this.state.enabled() };
  }
  private input(
    userId: string,
    kind: unknown,
    entityId: unknown,
    profile: unknown,
  ): MarketplaceBindingInput {
    return marketplaceBindingInputSchema.parse({ actorUserId: userId, kind, entityId, profile });
  }
  private statisticsAvailable(binding: MarketplaceBindingRow): boolean {
    // FLAG: Automatic analytics never clears an explicit profile/publication revoke.
    return (
      binding.statistics_revoked_at == null &&
      (binding.statistics_consent || centralEnabled(this.config))
    );
  }
  async get(userId: string, kind: unknown, entityId: unknown, profile: unknown) {
    const binding = await this.access.attest(this.input(userId, kind, entityId, profile));
    return this.present(binding, await this.relay(binding), await this.statistics(binding));
  }
  async mutate(userId: string, kind: unknown, entityId: unknown, profile: unknown, raw: unknown) {
    const input = marketplaceProfileMutationSchema.parse(raw);
    const identity = this.input(userId, kind, entityId, profile);
    const restrictive =
      input.action === 'revoke' || (input.action === 'toggle' && input.appendEnabled === false);
    const existing = restrictive
      ? await this.prisma.$queryRaw<MarketplaceBindingRow[]>`SELECT * FROM marketplace_bindings
      WHERE actor_user_id=${identity.actorUserId} AND entity_id=${identity.entityId} AND profile=${identity.profile} AND kind=${identity.kind}`
      : null;
    const resolved = existing ? existing[0] : await this.access.attest(identity);
    if (!resolved) throw new ConflictException('Привязка не найдена');
    let binding: MarketplaceBindingRow = resolved;
    if (input.action === 'toggle' || input.action === 'revoke') {
      const hash = createHash('sha256')
        .update(JSON.stringify({ bindingId: binding.id, ...input }))
        .digest('hex');
      const previous = await this.prisma.$queryRaw<
        Array<{ binding_id: string; payload_hash: string; result: unknown }>
      >`SELECT * FROM marketplace_policy_requests WHERE request_id=${input.requestId}::uuid`;
      if (previous[0]) {
        if (previous[0].binding_id !== binding.id || previous[0].payload_hash !== hash)
          throw new ConflictException('Идентификатор запроса уже использован');
        return marketplaceProfileStateSchema.parse(previous[0].result);
      }
      const policy = await this.publicationPolicy(binding);
      if (input.expectedRevision !== policy.appendRevision) {
        // FLAG: A duplicate may commit between the first receipt lookup and
        // this policy read. Its exact committed reply still wins over a conflict.
        const replay = await this.prisma.$queryRaw<
          Array<{ binding_id: string; payload_hash: string; result: unknown }>
        >`SELECT * FROM marketplace_policy_requests WHERE request_id=${input.requestId}::uuid`;
        if (replay[0]) {
          if (replay[0].binding_id !== binding.id || replay[0].payload_hash !== hash)
            throw new ConflictException('Идентификатор запроса уже использован');
          return marketplaceProfileStateSchema.parse(replay[0].result);
        }
        throw new ConflictException('Настройки изменились. Обновите экран');
      }
      if (input.action === 'toggle' && input.appendEnabled === undefined)
        throw new ConflictException('Не задано состояние кнопки');
      const current = restrictive ? this.cachedProfile(binding) : await this.relay(binding);
      if (
        input.action === 'toggle' &&
        input.appendEnabled &&
        (!this.statisticsAvailable(binding) ||
          current.listing?.status !== 'PUBLISHED' ||
          !current.listing.publicUrl)
      )
        throw new ConflictException('Сначала подтвердите и опубликуйте профиль');
      const result = current;
      return this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM chats WHERE id=${binding.entity_id} FOR UPDATE`;
        const locked = await tx.$queryRaw<
          MarketplaceBindingRow[]
        >`SELECT * FROM marketplace_bindings WHERE id=${binding.id}::uuid FOR UPDATE`;
        const replay = await tx.$queryRaw<
          Array<{ binding_id: string; payload_hash: string; result: unknown }>
        >`SELECT * FROM marketplace_policy_requests WHERE request_id=${input.requestId}::uuid`;
        if (replay[0]) {
          if (replay[0].binding_id !== binding.id || replay[0].payload_hash !== hash)
            throw new ConflictException('Идентификатор запроса уже использован');
          return marketplaceProfileStateSchema.parse(replay[0].result);
        }
        const currentBinding = locked[0];
        if (!currentBinding) throw new ConflictException('Настройки изменились. Обновите экран');
        const currentPolicy = await this.publicationPolicy(currentBinding, tx, true);
        if (
          currentPolicy.appendRevision !== input.expectedRevision ||
          (!restrictive &&
            (currentBinding.state !== 'ACTIVE' ||
              !this.statisticsAvailable(currentBinding) ||
              !currentBinding.valid_until ||
              currentBinding.valid_until.getTime() <= Date.now()))
        )
          throw new ConflictException('Настройки изменились. Обновите экран');
        const changed =
          input.action === 'revoke'
            ? await tx.$queryRaw<
                MarketplaceBindingRow[]
              >`UPDATE marketplace_bindings SET statistics_consent=false,statistics_revoked_at=COALESCE(statistics_revoked_at,now()),statistics_v2_consent_only=false,append_enabled=false,lease_id=NULL,lease_until=NULL,
            public_verified_until=NULL,append_revision=append_revision+1,revision=revision+1,updated_at=now() WHERE id=${binding.id}::uuid RETURNING *`
            : await tx.$queryRaw<
                MarketplaceBindingRow[]
              >`UPDATE marketplace_bindings SET append_enabled=${input.appendEnabled!},button_diagnostic=NULL,
            append_revision=append_revision+1,revision=revision+1,updated_at=now() WHERE id=${binding.id}::uuid RETURNING *`;
        if (input.action === 'toggle')
          await mirrorLegacyPublicationToggle(
            tx,
            { ...changed[0]!, profile_snapshot: result },
            input.appendEnabled!,
          );
        const presented = await this.present(changed[0]!, result, undefined, tx);
        // FLAG: Durable replies remain readable by the previous strict contract on rollback.
        delete presented.capabilities;
        delete presented.statistics;
        await tx.$executeRaw`INSERT INTO marketplace_policy_requests(request_id,binding_id,payload_hash,result)
          VALUES(${input.requestId}::uuid,${binding.id}::uuid,${hash},${JSON.stringify(presented)}::jsonb)`;
        return presented;
      });
    }
    if (
      input.action !== 'pause' &&
      !this.statisticsAvailable(binding) &&
      input.statisticsConsent !== true
    )
      throw new ConflictException('Профиль пока недоступен. Проверьте состояние позже.');
    const result = await this.relay(binding, input);
    if (input.action !== 'pause' && input.statisticsConsent === true) {
      const now = new Date();
      const from = new Date(now);
      from.setUTCHours(0, 0, 0, 0);
      from.setUTCDate(from.getUTCDate() - 89);
      // FLAG: Only an explicit legacy consent claims independent collection, atomically with its local policy CAS.
      const changed = await this.prisma
        .$executeRaw`UPDATE marketplace_bindings SET statistics_consent=true,statistics_v2_consent_only=false,statistics_revoked_at=NULL,
        history_from=CASE WHEN statistics_consent=false THEN ${from} ELSE history_from END,
        history_to=CASE WHEN statistics_consent=false THEN ${now} ELSE history_to END,
        history_cursor=CASE WHEN statistics_consent=false THEN ${now} ELSE history_cursor END,
        history_complete=CASE WHEN statistics_consent=false THEN false ELSE history_complete END,
        history_signature=CASE WHEN statistics_consent=false THEN NULL ELSE history_signature END,
        discovery_from=CASE WHEN statistics_consent=false THEN NULL ELSE discovery_from END,
        discovery_to=CASE WHEN statistics_consent=false THEN NULL ELSE discovery_to END,
        history_anomaly=CASE WHEN statistics_consent=false THEN false ELSE history_anomaly END,
        next_collect_at=now(),append_revision=append_revision+1,revision=revision+1,updated_at=now() WHERE id=${binding.id}::uuid
        AND append_revision=${binding.append_revision} AND state='ACTIVE' AND valid_until>now()`;
      if (!changed) throw new ConflictException('Согласие изменилось. Обновите экран');
      binding = (await this.state.read(binding.id))!;
    }
    return this.present(binding, result, await this.statistics(binding));
  }
  private cachedProfile(binding: MarketplaceBindingRow): MarketplaceProfileRelayResponse {
    const snapshot = marketplaceProfileRelayResponseSchema.safeParse(binding.profile_snapshot);
    if (
      snapshot.success &&
      snapshot.data.bindingId === binding.id &&
      snapshot.data.entityId === binding.entity_id &&
      snapshot.data.kind === binding.kind
    )
      return snapshot.data;
    return {
      bindingId: binding.id,
      entityId: binding.entity_id,
      kind: binding.kind,
      revision: binding.profile_revision,
      listing: null,
      choices: { topics: [], regions: [] },
    };
  }
  private async statistics(binding: MarketplaceBindingRow) {
    if (centralEnabled(this.config)) {
      const available = this.statisticsAvailable(binding);
      if (!available || !this.centralStats) return profileStatisticsSummary(available);
      try {
        const result = await this.centralStats.localSummary(
          { kind: binding.kind, maxId: binding.entity_id },
          binding.actor_user_id,
          binding.bot_id,
          90,
        );
        const item = result.results.find(
          (row) =>
            row.status === 'READY' &&
            row.entity.kind === binding.kind &&
            row.entity.maxId === binding.entity_id &&
            row.periodDays === 90,
        );
        if (item?.status !== 'READY') return profileStatisticsSummary(true);
        const audience = item.summary.audience;
        const from = new Date(result.asOf);
        from.setUTCHours(0, 0, 0, 0);
        from.setUTCDate(from.getUTCDate() - 89);
        if (audience.state === 'UNAVAILABLE') {
          if (audience.reason !== 'NO_DATA') return profileStatisticsSummary(true);
          return marketplaceProfileStatisticsSchema.parse({
            state: 'EMPTY',
            observedDays: 0,
            lastObservedAt: null,
            from: from.toISOString(),
            to: result.asOf,
          });
        }
        // FLAG: An external calendar count is not a measured audience-history day.
        if (audience.value.method.id !== 'AUDIENCE_SNAPSHOT') return profileStatisticsSummary(true);
        return marketplaceProfileStatisticsSchema.parse({
          state: 'AVAILABLE',
          observedDays: audience.coverage.knownDays,
          lastObservedAt: audience.value.observedAt,
          from: from.toISOString(),
          to: result.asOf,
        });
      } catch {
        return profileStatisticsSummary(true);
      }
    }
    if (!binding.statistics_consent || !binding.generation_id)
      return profileStatisticsSummary(binding.statistics_consent);
    const generations = await this.prisma.$queryRaw<Array<{ manifest: unknown; rows: unknown }>>`
      SELECT manifest,rows FROM marketplace_statistics_generations WHERE id=${binding.generation_id}::uuid AND binding_id=${binding.id}::uuid`;
    return profileStatisticsSummary(binding.statistics_consent, generations[0]);
  }
  private async publicationPolicy(
    binding: MarketplaceBindingRow,
    db: ProfileSql = this.prisma,
    lock = false,
  ) {
    const rows = await db.$queryRaw<
      Array<{ revision: number; enabled: boolean | null; diagnostic: string | null }>
    >(Prisma.sql`
      SELECT p.revision,c.enabled,c.diagnostic FROM marketplace_button_policies p
      LEFT JOIN LATERAL (
        SELECT bool_or(c.enabled) enabled,
          CASE WHEN bool_or(c.diagnostic='KEYBOARD_FULL') THEN 'KEYBOARD_FULL' ELSE NULL END diagnostic
        FROM marketplace_button_contexts c WHERE c.policy_id=p.id
          AND (c.context IN ('PUBLICATION','VK_IMPORT','APPROVED_SUGGESTION') OR
            (c.context='PUBLICATIONS' AND NOT EXISTS(SELECT 1 FROM marketplace_button_contexts child
              WHERE child.policy_id=p.id AND child.context IN ('PUBLICATION','VK_IMPORT','APPROVED_SUGGESTION'))))
      ) c ON true
      WHERE p.entity_id=${binding.entity_id} AND p.kind=${binding.kind} AND p.profile=${binding.profile}
      ${lock ? Prisma.sql`FOR UPDATE OF p` : Prisma.empty}
    `);
    const policy = rows[0];
    return {
      appendEnabled: policy?.enabled ?? binding.append_enabled,
      // FLAG: Both counters are monotonic. Their sum fences old forms after a
      // platform change without colliding with the actor's pre-policy revision.
      appendRevision: binding.append_revision + (policy?.revision ?? 0),
      buttonDiagnostic: policy?.enabled != null ? policy.diagnostic : binding.button_diagnostic,
    };
  }
  private async present(
    binding: MarketplaceBindingRow,
    result: MarketplaceProfileRelayResponse,
    statistics = profileStatisticsSummary(this.statisticsAvailable(binding)),
    db: ProfileSql = this.prisma,
  ) {
    const policy = await this.publicationPolicy(binding, db);
    return marketplaceProfileStateSchema.parse({
      ...result,
      binding: this.state.present(binding),
      ...policy,
      available: true,
      statistics,
    });
  }
  async relay(
    binding: MarketplaceBindingRow,
    mutation?: z.infer<typeof marketplaceProfileMutationSchema>,
  ): Promise<MarketplaceProfileRelayResponse> {
    const token = this.config.get<string>('SVYAZKA_PROFILE_TOKEN');
    if (!token) throw new ServiceUnavailableException('Связка пока не подключена');
    const identity = {
      bindingId: binding.id,
      actorUserId: binding.actor_user_id,
      entityId: binding.entity_id,
      kind: binding.kind,
      profile: binding.profile,
    };
    const url = new URL(PROFILE_URL);
    if (!mutation)
      for (const [key, value] of Object.entries(identity)) url.searchParams.set(key, value);
    try {
      const response = await fetch(url, {
        method: mutation ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          'x-marketplace-profile-view': '2',
          ...(mutation ? { 'content-type': 'application/json' } : {}),
        },
        ...(mutation ? { body: JSON.stringify({ ...identity, ...mutation }) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 409) throw new ConflictException('Профиль изменился. Обновите экран');
      const result = marketplaceProfileRelayResponseSchema.parse(
        await readMarketplaceResponse(response),
      );
      if (
        result.bindingId !== binding.id ||
        result.entityId !== binding.entity_id ||
        result.kind !== binding.kind
      )
        throw new Error('Binding mismatch');
      const publicUrl = result.listing?.status === 'PUBLISHED' ? result.listing.publicUrl : null;
      if (
        publicUrl &&
        publicUrl !==
          `${PUBLIC_BOT}?startapp=listing_${binding.kind === 'CHANNEL' ? 'channel' : 'chat'}_${result.listing!.id}`
      )
        throw new Error('Link mismatch');
      if (result.capabilities) {
        const kind = binding.kind === 'CHANNEL' ? 'channel' : 'chat';
        if (
          result.capabilities.connectUrl !==
            `${PUBLIC_BOT}?startapp=connect_${kind}_${binding.entity_id}` ||
          (result.capabilities.manageUrl !== null &&
            result.capabilities.manageUrl !==
              `${PUBLIC_BOT}?startapp=manage_${kind}_${result.listing?.id}`)
        )
          throw new Error('Handoff link mismatch');
      }
      const snapshot = { ...result };
      delete snapshot.capabilities;
      // FLAG: A response started before a revoke must not renew the usable public link.
      await this.prisma
        .$executeRaw`UPDATE marketplace_bindings SET public_url=${publicUrl},public_verified_until=${publicUrl ? new Date(Date.now() + 5 * 60_000) : null},
        profile_revision=${result.revision},profile_snapshot=${JSON.stringify(snapshot)}::jsonb WHERE id=${binding.id}::uuid AND revision=${binding.revision} AND state='ACTIVE' AND valid_until>now()`;
      return result;
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException('Не удалось проверить профиль в Связке');
    }
  }
}
