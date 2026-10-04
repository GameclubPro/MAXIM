import {
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  marketplaceBindingInputSchema,
  marketplaceProfileMutationSchema,
  marketplaceProfileRelayResponseSchema,
  marketplaceProfileStateSchema,
  type MarketplaceBindingInput,
  type MarketplaceProfileRelayResponse,
} from '@maxim/contracts/marketplace-integration';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { profileStatisticsSummary } from './marketplace-profile-statistics';
import { MarketplaceAccessService } from './marketplace-access.service';
import {
  MarketplaceStateService,
  MARKETPLACE_PILOT_USER_ID,
  type MarketplaceBindingRow,
} from './marketplace-state.service';

const PROFILE_URL = 'https://major-maksimov.ru/market/api/integrations/maxim/v1/profile';
const PUBLIC_BOT = 'https://max.ru/id613000037577_3_bot';
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
  ) {}
  capability(userId: string) {
    return { available: userId === MARKETPLACE_PILOT_USER_ID && this.state.enabled() };
  }
  private input(
    userId: string,
    kind: unknown,
    entityId: unknown,
    profile: unknown,
  ): MarketplaceBindingInput {
    if (userId !== MARKETPLACE_PILOT_USER_ID)
      throw new ForbiddenException('Модуль пока недоступен');
    return marketplaceBindingInputSchema.parse({ actorUserId: userId, kind, entityId, profile });
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
      if (input.expectedRevision !== binding.append_revision)
        throw new ConflictException('Настройки изменились. Обновите экран');
      if (input.action === 'toggle' && input.appendEnabled === undefined)
        throw new ConflictException('Не задано состояние кнопки');
      const current = restrictive ? this.cachedProfile(binding) : await this.relay(binding);
      if (
        input.action === 'toggle' &&
        input.appendEnabled &&
        (!binding.statistics_consent ||
          current.listing?.status !== 'PUBLISHED' ||
          !current.listing.publicUrl)
      )
        throw new ConflictException('Сначала подтвердите и опубликуйте профиль');
      const result = current;
      return this.prisma.$transaction(async (tx) => {
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
        if (
          !currentBinding ||
          currentBinding.append_revision !== input.expectedRevision ||
          (!restrictive &&
            (currentBinding.state !== 'ACTIVE' ||
              !currentBinding.valid_until ||
              currentBinding.valid_until.getTime() <= Date.now()))
        )
          throw new ConflictException('Настройки изменились. Обновите экран');
        const changed =
          input.action === 'revoke'
            ? await tx.$queryRaw<
                MarketplaceBindingRow[]
              >`UPDATE marketplace_bindings SET statistics_consent=false,append_enabled=false,state='REVOKED',valid_until=NULL,lease_id=NULL,lease_until=NULL,
            public_verified_until=NULL,append_revision=append_revision+1,revision=revision+1,checked_at=now(),updated_at=now() WHERE id=${binding.id}::uuid RETURNING *`
            : await tx.$queryRaw<
                MarketplaceBindingRow[]
              >`UPDATE marketplace_bindings SET append_enabled=${input.appendEnabled!},button_diagnostic=NULL,
            append_revision=append_revision+1,revision=revision+1,updated_at=now() WHERE id=${binding.id}::uuid RETURNING *`;
        const presented = this.present(changed[0]!, result);
        // FLAG: Durable replies remain readable by the previous strict contract on rollback.
        delete presented.capabilities;
        delete presented.statistics;
        await tx.$executeRaw`INSERT INTO marketplace_policy_requests(request_id,binding_id,payload_hash,result)
          VALUES(${input.requestId}::uuid,${binding.id}::uuid,${hash},${JSON.stringify(presented)}::jsonb)`;
        return presented;
      });
    }
    if (input.action !== 'pause' && !binding.statistics_consent && input.statisticsConsent !== true)
      throw new ConflictException('Подтвердите использование статистики');
    const result = await this.relay(binding, input);
    if (input.action !== 'pause' && !binding.statistics_consent) {
      const now = new Date();
      const from = new Date(now);
      from.setUTCHours(0, 0, 0, 0);
      from.setUTCDate(from.getUTCDate() - 89);
      const changed = await this.prisma
        .$executeRaw`UPDATE marketplace_bindings SET statistics_consent=true,history_from=${from},history_to=${now},history_cursor=${now},
        history_complete=false,history_signature=NULL,discovery_from=NULL,discovery_to=NULL,history_anomaly=false,
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
    if (!binding.statistics_consent || !binding.generation_id)
      return profileStatisticsSummary(binding.statistics_consent);
    const generations = await this.prisma.$queryRaw<Array<{ manifest: unknown; rows: unknown }>>`
      SELECT manifest,rows FROM marketplace_statistics_generations WHERE id=${binding.generation_id}::uuid AND binding_id=${binding.id}::uuid`;
    return profileStatisticsSummary(binding.statistics_consent, generations[0]);
  }
  private present(
    binding: MarketplaceBindingRow,
    result: MarketplaceProfileRelayResponse,
    statistics = profileStatisticsSummary(binding.statistics_consent),
  ) {
    return marketplaceProfileStateSchema.parse({
      ...result,
      binding: this.state.present(binding),
      appendEnabled: binding.append_enabled,
      appendRevision: binding.append_revision,
      available: true,
      buttonDiagnostic: binding.button_diagnostic,
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
