import { Injectable, Optional } from '@nestjs/common';
import type { ChatSettings } from '../../prisma/prisma-client';
import { raceWithTimeout } from '../../common/promise-timeout.util';
import { resolveDuplicateFlowConfig } from '../duplicate-flow-policy';
import { RedisCounterService } from '../redis-counter.service';
import {
  RuleEngineDuplicateDetector,
  type DuplicateFingerprint,
} from '../rule-engine-duplicate-detector';
import type { DuplicateHit } from '../rule-engine.contract';
import { MessageDuplicateMetricsService } from './message-duplicate-metrics.service';
import { resolveDuplicateDailyWindow } from './message-duplicate-schedule';
import {
  buildMessageDuplicateIdentity,
  digestDuplicateContent,
  exactImageSourceDigest,
  type DuplicateMessageContent,
} from './message-duplicate-content';
import {
  MESSAGE_DUPLICATE_MEDIA_VERSION,
  messageDuplicateOriginalSchema,
  messageDuplicateSettingsDigest,
  exactImageSettingsDigest,
  type MessageDuplicateBinding,
} from './message-duplicate-state';

export type MessageDuplicateObservation = {
  content: DuplicateMessageContent;
  chatId: string;
  userId: string;
  messageId: string;
  eventTimestampMs: number;
  publishedAtMs?: number;
  controlRevision: number;
  settings: ChatSettings;
  mediaHashes?: readonly string[];
  imageScope?: 'SAME_AUTHOR' | 'CHAT';
};

export const MESSAGE_DUPLICATE_FINGERPRINT_LIMIT = 16;

export function selectMessageDuplicateFingerprints(
  fingerprints: readonly DuplicateFingerprint[],
): DuplicateFingerprint[] {
  if (fingerprints.length <= MESSAGE_DUPLICATE_FINGERPRINT_LIMIT) return [...fingerprints];
  const groups = new Map<DuplicateFingerprint['type'], DuplicateFingerprint[]>();
  for (const fingerprint of fingerprints) {
    const group = groups.get(fingerprint.type) ?? [];
    group.push(fingerprint);
    groups.set(fingerprint.type, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  }
  // FLAG: A large link list must not evict enabled phone/content/near matching. Both candidate
  // lookup and verified membership use this deterministic, type-balanced bounded selection.
  const selected: DuplicateFingerprint[] = [];
  for (let index = 0; selected.length < MESSAGE_DUPLICATE_FINGERPRINT_LIMIT; index += 1) {
    for (const group of groups.values()) {
      if (group[index]) selected.push(group[index]);
      if (selected.length === MESSAGE_DUPLICATE_FINGERPRINT_LIMIT) break;
    }
  }
  return selected;
}

@Injectable()
export class MessageDuplicateHistoryService {
  private readonly fingerprints: RuleEngineDuplicateDetector;
  constructor(
    private readonly redis: RedisCounterService,
    @Optional() private readonly metrics?: MessageDuplicateMetricsService,
  ) {
    this.fingerprints = new RuleEngineDuplicateDetector(redis);
  }

  candidateKeys(
    content: DuplicateMessageContent,
    settings: ChatSettings,
    imageOnly = false,
  ): string[] {
    if (imageOnly) return [digestDuplicateContent(['exact-image-v1', content.media.length])];
    const parts = this.buildFingerprints(content, settings);
    return parts.map((part) =>
      digestDuplicateContent({
        version: 1,
        value: part.value,
        type: part.type,
        textPresent: content.text.length > 0,
        actions: content.actions,
        media: content.media.map((media) => media.kind),
      }),
    );
  }

  async observe(
    input: MessageDuplicateObservation,
  ): Promise<{ hit: DuplicateHit; binding: MessageDuplicateBinding } | null> {
    const dailyWindow = resolveDuplicateDailyWindow(input.settings, input.eventTimestampMs);
    if (dailyWindow === null) return null;
    const mode = input.imageScope
      ? 'IMAGE'
      : input.settings.duplicateCompareMode === 'TEXT'
        ? 'TEXT'
        : 'MESSAGE';
    const mediaHashes = [...(input.mediaHashes ?? [])];
    const identity = buildMessageDuplicateIdentity(input.content, mode, mediaHashes);
    const flow = resolveDuplicateFlowConfig(input.settings);
    const windowSec = dailyWindow
      ? Math.ceil((dailyWindow.endMs - dailyWindow.startMs) / 1000)
      : flow.windowSec;
    const parts: DuplicateFingerprint[] = identity
      ? mode === 'IMAGE'
        ? [{ type: input.content.media.length === 1 ? 'image' : 'image_set', value: identity }]
        : this.buildFingerprints(input.content, input.settings)
      : [];
    const settingsDigest =
      mode === 'IMAGE'
        ? exactImageSettingsDigest(input.settings)
        : messageDuplicateSettingsDigest(input.settings);
    const patterns = parts.map((part) => ({
      part,
      hash: digestDuplicateContent({
        version: 1,
        mode,
        controlRevision: input.controlRevision,
        settingsDigest,
        type: part.type,
        textPresent: mode === 'IMAGE' ? false : input.content.text.length > 0,
        value: part.value,
        actions: mode === 'IMAGE' ? [] : input.content.actions,
        media:
          mode === 'MESSAGE'
            ? input.content.media.map((media, index) => [media.kind, mediaHashes[index]])
            : [],
      }),
    }));
    const sourceDigest = duplicateSourceDigest(input.content, mode);
    const mutation = await this.window(input.chatId, {
      op: 'observe',
      mode,
      scope:
        mode === 'IMAGE' && input.imageScope === 'CHAT'
          ? 'chat'
          : digestDuplicateContent(input.userId),
      member: digestDuplicateContent(input.messageId),
      author: digestDuplicateContent(input.userId),
      messageId: input.messageId,
      senderId: input.userId,
      at: input.eventTimestampMs,
      publishedAt: input.publishedAtMs ?? input.eventTimestampMs,
      source: sourceDigest,
      identity: identity ?? '',
      mediaHashes,
      fingerprints: patterns.map((pattern) => pattern.hash),
      allowed: flow.allowedCount,
      windowMs: windowSec * 1000,
      context: digestDuplicateContent([
        settingsDigest,
        input.controlRevision,
        dailyWindow?.startMs,
      ]),
      ...(dailyWindow ? { periodStart: dailyWindow.startMs, periodEnd: dailyWindow.endMs } : {}),
    });
    if (mutation.kind === 'replayed') this.metrics?.record('history.replayed');
    if (!identity || mutation.kind === 'stale') {
      this.metrics?.record(identity ? 'history.stale' : 'history.unverified');
      return null;
    }
    const matches = Array.isArray(mutation.matches) ? mutation.matches : [];
    const selected = matches.sort((a, b) => (b.qualified ?? b.count) - (a.qualified ?? a.count))[0];
    const pattern = selected && patterns.find((part) => part.hash === selected.fingerprint);
    if (!selected || !pattern) {
      this.metrics?.record('history.no_match_or_allowed');
      return null;
    }
    this.metrics?.record('history.matched');
    const match = { ...pattern, count: selected.qualified ?? selected.count };
    const binding: MessageDuplicateBinding = {
      version: mode === 'IMAGE' ? 2 : 1,
      original: messageDuplicateOriginalSchema.parse({
        ...selected.original,
        mediaHashes: Array.isArray(selected.original.mediaHashes)
          ? selected.original.mediaHashes
          : [],
      }),
      senderId: input.userId,
      messageId: input.messageId,
      eventTimestampMs: mutation.observedAt ?? input.eventTimestampMs,
      controlRevision: input.controlRevision,
      compareMode: mode,
      ...(input.imageScope ? { imageScope: input.imageScope } : {}),
      settingsDigest,
      sourceDigest,
      contentDigest: identity,
      fingerprint: match.hash,
      mediaHashes,
      mediaVersion: MESSAGE_DUPLICATE_MEDIA_VERSION,
      hasPhotos: mode !== 'TEXT' && input.content.media.some((media) => media.kind === 'photo'),
      photoControlRevision: null,
      windowSeconds: windowSec,
      requiredCount: flow.allowedCount + 2,
    };
    return {
      binding,
      hit: {
        count: match.count,
        windowSec,
        hash: match.hash,
        fingerprintType: match.part.type,
        metadata: { duplicateSource: 'message_v1', messageDuplicate: binding },
      },
    };
  }

  async observeLifecycle(input: {
    chatId: string;
    messageId: string;
    eventTimestampMs: number;
    content: DuplicateMessageContent;
  }): Promise<void> {
    await this.window(input.chatId, {
      op: 'lifecycle',
      member: digestDuplicateContent(input.messageId),
      at: input.eventTimestampMs,
      sources: {
        TEXT: duplicateSourceDigest(input.content, 'TEXT'),
        MESSAGE: duplicateSourceDigest(input.content, 'MESSAGE'),
        IMAGE: duplicateSourceDigest(input.content, 'IMAGE'),
      },
    });
  }

  async remove(chatId: string, messageId: string): Promise<void> {
    await this.window(chatId, { op: 'remove', member: digestDuplicateContent(messageId) });
  }

  async stillMatches(
    chatId: string,
    binding: MessageDuplicateBinding,
    afterDelete = false,
  ): Promise<boolean> {
    if (!binding.original) return false;
    const result = await this.window(chatId, {
      ...this.checkInput(binding),
      op: 'check',
      afterDelete,
    });
    return result.kind === 'ok' && (result.count ?? 0) >= binding.requiredCount - 1;
  }

  async qualified(chatId: string, binding: MessageDuplicateBinding): Promise<number | null> {
    if (!binding.original) return null;
    const result = await this.window(chatId, {
      ...this.checkInput(binding),
      op: 'check',
      afterDelete: true,
    });
    return result.kind === 'ok' ? (result.qualified ?? null) : null;
  }

  async qualify(chatId: string, binding: MessageDuplicateBinding): Promise<number | null> {
    if (!binding.original) return null;
    const result = await this.window(chatId, { ...this.checkInput(binding), op: 'qualify' });
    return result.kind === 'ok' ? (result.count ?? null) : null;
  }

  private checkInput(binding: MessageDuplicateBinding) {
    return {
      mode: binding.compareMode,
      member: digestDuplicateContent(binding.messageId),
      author: digestDuplicateContent(binding.senderId),
      source: binding.sourceDigest,
      identity: binding.contentDigest,
      original: binding.original,
      fingerprint: binding.fingerprint,
      at: binding.eventTimestampMs,
      allowed: binding.requiredCount - 2,
      windowMs: binding.windowSeconds * 1000,
    };
  }

  private async window(chatId: string, input: Record<string, unknown>) {
    return raceWithTimeout({
      operation: () => this.redis.duplicateWindow(chatId, input),
      timeoutMs: 250,
      onTimeout: () => {
        throw new Error('Message duplicate history deadline exceeded');
      },
    }).catch((error: unknown) => {
      this.metrics?.record('history.unavailable');
      throw error;
    });
  }

  private buildFingerprints(content: DuplicateMessageContent, settings: ChatSettings) {
    const all = this.fingerprints.buildFingerprints(
      // FLAG: URL paths, query values and fragments are case-sensitive. Normalize prose inside
      // the detector, never before extracting navigation value fingerprints.
      content.rawText,
      settings,
      content.navigationTargets,
    );
    if (all.length > MESSAGE_DUPLICATE_FINGERPRINT_LIMIT)
      this.metrics?.record('history.fingerprint_budget');
    const parts = selectMessageDuplicateFingerprints(all);
    if (parts.length === 0) parts.push({ type: 'exact', value: '' });
    return parts;
  }
}

export function duplicateSourceDigest(
  content: DuplicateMessageContent,
  mode: 'TEXT' | 'MESSAGE' | 'IMAGE',
): string {
  return mode === 'IMAGE'
    ? exactImageSourceDigest(content)
    : mode === 'TEXT'
      ? (buildMessageDuplicateIdentity(content, 'TEXT') ?? content.sourceDigest)
      : content.sourceDigest;
}
