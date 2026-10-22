import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  networkSettingsRequiredSubscriptionResolveRequestSchema,
  networkSettingsRequiredSubscriptionResolveResponseSchema,
  networkSettingsAdminContactsReadRequestSchema,
  networkSettingsAdminContactsResolveRequestSchema,
  networkSettingsAdminContactsResponseSchema,
  networkSettingsAdminContactResolveResponseSchema,
  type NetworkSettingsReadRequest,
} from '@maxim/contracts/network-settings';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { AdminSettingsService } from './admin-settings.service';
import { ManagedEntitiesService } from './managed-entities.service';
import { ManagedEntityNetworksService } from './managed-entity-networks.service';
import { NetworkAuthorizationService } from './network-authorization.service';
import { MaxClientService } from '../max/max-client.service';
import { buildUserProfileUrl, normalizeMaxProfileUrl } from './admin-profile-links';
type MetadataScope = NetworkSettingsReadRequest & { compositionVersion: string; requestId: string };
type Contact = { userId: string; displayName: string | null; url: string; sources: string[] };
type AdminContactsResponse = z.infer<typeof networkSettingsAdminContactsResponseSchema>;
type Session = {
  id: string;
  binding: string;
  createdAt: number;
  touchedAt: number;
  next: number;
  entityIds: string[];
  contacts: Map<string, Contact>;
  proofs: Map<string, string>;
  incompleteSources: string[];
  unavailableSources: string[];
  pending?: Promise<AdminContactsResponse>;
};
const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? '[' + v.map(canonical).join(',') + ']'
    : v && typeof v === 'object'
      ? '{' +
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => JSON.stringify(k) + ':' + canonical(x))
          .join(',') +
        '}'
      : JSON.stringify(v);
function changed() {
  return new ConflictException({
    code: 'NETWORK_SETTINGS_METADATA_CHANGED',
    message: 'Состав или доступ изменился. Откройте выбор заново.',
  });
}
@Injectable()
export class NetworkSettingsMetadataService {
  private readonly sessions = new Map<string, Session>();
  constructor(
    @Inject(ManagedEntityNetworksService)
    private readonly networks: Pick<ManagedEntityNetworksService, 'resolveSelection'>,
    @Inject(ManagedEntitiesService)
    private readonly managed: Pick<
      ManagedEntitiesService,
      'assertManagedEntityReadAccess' | 'resolveManagedEntityReadBotId'
    >,
    @Inject(NetworkAuthorizationService)
    private readonly authorization: Pick<NetworkAuthorizationService, 'acquireSlot' | 'readEpochs'>,
    @Inject(MaxClientService)
    private readonly max: Pick<MaxClientService, 'getChatAdminMembersPage'>,
    @Inject(AdminSettingsService)
    private readonly settings: Pick<
      AdminSettingsService,
      'resolveRequiredSubscriptionChannelReference' | 'resolveLocalChatUserProfiles'
    >,
  ) {}
  private async selection(user: AuthUser, request: MetadataScope) {
    if (request.entityType !== 'chat')
      throw new BadRequestException('Этот выбор доступен в настройках чатов.');
    const selected =
      request.target.mode === 'category'
        ? await this.networks.resolveSelection(user, 'chat', request.target.favoriteType)
        : {
            entityIds: [...request.target.entityIds].sort(),
            compositionVersion: createHash('sha256')
              .update(
                canonical({ entityType: 'chat', entityIds: [...request.target.entityIds].sort() }),
              )
              .digest('hex'),
          };
    if (selected.compositionVersion !== request.compositionVersion) throw changed();
    return selected;
  }
  private async witness(user: AuthUser, entityId: string) {
    const startedAt = new Date();
    await this.managed.assertManagedEntityReadAccess(entityId, user, 'chat', { timeoutMs: 2500 });
    const proof = (
      await this.authorization.readEpochs(
        { userId: user.userId, entityType: 'chat' },
        [entityId],
        startedAt,
      )
    ).get(entityId);
    if (!proof) throw changed();
    return proof;
  }
  private async assertProofs(user: AuthUser, request: MetadataScope, proofs: Map<string, string>) {
    await this.selection(user, request);
    const current = await this.authorization.readEpochs(
      { userId: user.userId, entityType: 'chat' },
      [...proofs.keys()],
    );
    if ([...proofs].some(([id, epoch]) => current.get(id) !== epoch)) throw changed();
  }
  async resolveRequiredSubscription(user: AuthUser, body: unknown) {
    const parsed = networkSettingsRequiredSubscriptionResolveRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.format());
    const request = parsed.data;
    if (request.section !== 'requiredSubscription')
      throw new BadRequestException('Неверный раздел.');
    const selection = await this.selection(user, request);
    if (!selection.entityIds.length) throw new BadRequestException('Сначала выберите сообщества.');
    const release = await this.authorization.acquireSlot();
    try {
      let authorized: { id: string; proof: string } | undefined;
      for (const id of selection.entityIds.slice(0, 4)) {
        try {
          authorized = { id, proof: await this.witness(user, id) };
          break;
        } catch {
          // FLAG: A failed witness grants no access; only remaining bounded candidates are tried.
        }
      }
      if (!authorized)
        throw new ServiceUnavailableException(
          'Не удалось проверить доступ. Выберите доступные сообщества и повторите поиск.',
        );
      const result = await this.settings.resolveRequiredSubscriptionChannelReference(request.value);
      await this.assertProofs(user, request, new Map([[authorized.id, authorized.proof]]));
      return networkSettingsRequiredSubscriptionResolveResponseSchema.parse({
        requestId: request.requestId,
        compositionVersion: request.compositionVersion,
        channel: result,
      });
    } finally {
      release();
    }
  }
  async readAdminContacts(user: AuthUser, body: unknown): Promise<AdminContactsResponse> {
    const parsed = networkSettingsAdminContactsReadRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.format());
    const request = parsed.data;
    const selection = await this.selection(user, request);
    const binding = canonical({
      userId: user.userId,
      entityType: request.entityType,
      target: request.target,
      section: request.section,
      compositionVersion: request.compositionVersion,
      requestId: request.requestId,
    });
    const now = Date.now();
    for (const [id, s] of this.sessions)
      if (now - s.createdAt > 10 * 60_000 || now - s.touchedAt > 60_000) this.sessions.delete(id);
    let session = request.cursor ? this.sessions.get(request.cursor) : undefined;
    if (request.cursor && !session) throw changed();
    if (session && session.binding !== binding) throw changed();
    if (!session) {
      if (this.sessions.size >= 100)
        throw new ServiceUnavailableException('Выбор администраторов временно занят.');
      session = {
        id: randomUUID(),
        binding,
        createdAt: now,
        touchedAt: now,
        next: 0,
        entityIds: selection.entityIds,
        contacts: new Map(),
        proofs: new Map(),
        incompleteSources: [],
        unavailableSources: [],
      };
      this.sessions.set(session.id, session);
    }
    session.touchedAt = now;
    if (session.pending) return session.pending;
    const current = session;
    const pending = (async () => {
      const changedContacts = new Set<string>();
      for (const id of current.entityIds.slice(current.next, current.next + 2)) {
        const release = await this.authorization.acquireSlot();
        try {
          const proof = await this.witness(user, id);
          const botId = await this.managed.resolveManagedEntityReadBotId(id);
          if (!botId) throw changed();
          const page = await this.max.getChatAdminMembersPage(id, {
            botId,
            trafficClass: 'interactive',
            timeoutMs: 2500,
            bypassCache: true,
          });
          await this.assertProofs(user, request, new Map([[id, proof]]));
          const humans = page.members.filter((row) => row.isBot === false);
          const profiles = await this.settings.resolveLocalChatUserProfiles(
            id,
            humans.map((row) => row.userId),
          );
          for (const member of humans) {
            const profile = profiles.get(member.userId);
            const url =
              normalizeMaxProfileUrl(member.profileUrl) ??
              buildUserProfileUrl(member.username) ??
              profile?.profileHandoffUrl ??
              null;
            if (!url) continue;
            const old = current.contacts.get(member.userId);
            current.contacts.set(member.userId, {
              userId: member.userId,
              displayName: member.displayName ?? profile?.displayName ?? null,
              url,
              sources: [...new Set([...(old?.sources ?? []), id])],
            });
            changedContacts.add(member.userId);
          }
          current.proofs.set(id, proof);
          if (!page.complete) current.incompleteSources.push(id);
        } catch {
          current.unavailableSources.push(id);
        } finally {
          release();
        }
      }
      current.next = Math.min(current.next + 2, current.entityIds.length);
      await this.assertProofs(user, request, current.proofs);
      return networkSettingsAdminContactsResponseSchema.parse({
        requestId: request.requestId,
        compositionVersion: request.compositionVersion,
        sessionId: current.id,
        items: [...changedContacts].map((id) => current.contacts.get(id)),
        scannedSources: current.next,
        totalSources: current.entityIds.length,
        incompleteSources: current.incompleteSources,
        unavailableSources: current.unavailableSources,
        complete:
          current.next === current.entityIds.length &&
          current.incompleteSources.length === 0 &&
          current.unavailableSources.length === 0,
        nextCursor: current.next < current.entityIds.length ? current.id : null,
      });
    })().finally(() => {
      current.pending = undefined;
    });
    current.pending = pending;
    return pending;
  }
  async resolveAdminContact(user: AuthUser, body: unknown) {
    const parsed = networkSettingsAdminContactsResolveRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.format());
    const request = parsed.data;
    await this.selection(user, request);
    const session = this.sessions.get(request.cursor);
    const binding = canonical({
      userId: user.userId,
      entityType: request.entityType,
      target: request.target,
      section: request.section,
      compositionVersion: request.compositionVersion,
      requestId: request.requestId,
    });
    const contact = session?.contacts.get(request.userId);
    if (
      !session ||
      session.binding !== binding ||
      Date.now() - session.createdAt > 10 * 60_000 ||
      !contact?.sources.includes(request.sourceEntityId)
    )
      throw changed();
    const release = await this.authorization.acquireSlot();
    try {
      const proof = await this.witness(user, request.sourceEntityId);
      const botId = await this.managed.resolveManagedEntityReadBotId(request.sourceEntityId);
      if (!botId) throw changed();
      const page = await this.max.getChatAdminMembersPage(request.sourceEntityId, {
        botId,
        trafficClass: 'interactive',
        timeoutMs: 2500,
        bypassCache: true,
      });
      if (
        !page.members.some((member) => member.userId === request.userId && member.isBot === false)
      )
        throw changed();
      await this.assertProofs(user, request, new Map([[request.sourceEntityId, proof]]));
      session.touchedAt = Date.now();
      return networkSettingsAdminContactResolveResponseSchema.parse({
        requestId: request.requestId,
        compositionVersion: request.compositionVersion,
        contact,
      });
    } finally {
      release();
    }
  }
}
