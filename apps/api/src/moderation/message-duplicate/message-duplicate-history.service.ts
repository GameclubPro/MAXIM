import { Injectable, Optional } from '@nestjs/common';
import type { ChatSettings } from '../../prisma/prisma-client';
import { raceWithTimeout } from '../../common/promise-timeout.util';
import { resolveDuplicateFlowConfig } from '../duplicate-flow-policy';
import { resolveDuplicateHistoryRetentionSeconds } from '../duplicate-state';
import { RedisCounterService } from '../redis-counter.service';
import {
  RuleEngineDuplicateDetector,
  type DuplicateFingerprint,
} from '../rule-engine-duplicate-detector';
import type { DuplicateHit } from '../rule-engine.contract';
import { MessageDuplicateMetricsService } from './message-duplicate-metrics.service';
import {
  buildMessageDuplicateIdentity,
  digestDuplicateContent,
  exactImageSourceDigest,
  type DuplicateMessageContent,
} from './message-duplicate-content';
import {
  MESSAGE_DUPLICATE_MEDIA_VERSION,
  messageDuplicateKeys,
  messageDuplicateSettingsDigest,
  exactImageSettingsDigest,
  exactImageKeys,
  type MessageDuplicateBinding,
} from './message-duplicate-state';

export type MessageDuplicateObservation = {
  content: DuplicateMessageContent;
  chatId: string;
  userId: string;
  messageId: string;
  eventTimestampMs: number;
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
    const mode = input.imageScope
      ? 'IMAGE'
      : input.settings.duplicateCompareMode === 'TEXT'
        ? 'TEXT'
        : 'MESSAGE';
    const mediaHashes = [...(input.mediaHashes ?? [])];
    const identity = buildMessageDuplicateIdentity(input.content, mode, mediaHashes);
    const flow = resolveDuplicateFlowConfig(input.settings);
    const keys = input.imageScope
      ? exactImageKeys(input.chatId, input.userId, input.messageId, '', input.imageScope)
      : messageDuplicateKeys(input.chatId, input.userId, input.messageId, '');
    const deadlineAtMs = Date.now() + 250;
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
    const memberships = patterns.map((pattern) =>
      input.imageScope
        ? exactImageKeys(
            input.chatId,
            input.userId,
            input.messageId,
            pattern.hash,
            input.imageScope,
          )
        : messageDuplicateKeys(input.chatId, input.userId, input.messageId, pattern.hash),
    );
    const sharedImageKeys =
      input.imageScope === 'CHAT' && patterns[0]
        ? exactImageKeys(input.chatId, input.userId, input.messageId, patterns[0].hash, 'CHAT')
        : null;
    const revision = input.eventTimestampMs * 2 + (identity ? 1 : 0);
    const mutation = await raceWithTimeout({
      operation: () =>
        this.redis.replaceRevisionedSetMembershipsBeforeDeadline({
          stateKey: keys.stateKey,
          member: keys.member,
          revision,
          scoreTimestampMs: input.eventTimestampMs,
          membershipKeys: sharedImageKeys
            ? [sharedImageKeys.membershipKey, sharedImageKeys.authorMembershipKey]
            : memberships.map((entry) => entry.membershipKey),
          ...(sharedImageKeys
            ? {
                sharedBaseline: {
                  sharedKey: sharedImageKeys.membershipKey,
                  authorKey: sharedImageKeys.authorMembershipKey,
                },
              }
            : {}),
          windowSeconds: flow.windowSec,
          ttlSeconds: resolveDuplicateHistoryRetentionSeconds(flow.windowSec),
          countLimit: 21,
          deadlineAtMs,
        }),
      timeoutMs: 250,
      onTimeout: () => {
        throw new Error('Message duplicate history deadline exceeded');
      },
    }).catch((error: unknown) => {
      this.metrics?.record('history.unavailable');
      throw error;
    });
    if (mutation.kind === 'deadline_exceeded') {
      this.metrics?.record('history.unavailable');
      throw new Error('Message duplicate history deadline exceeded');
    }
    if (mutation.kind === 'replayed') this.metrics?.record('history.replayed');
    if (!identity || mutation.kind === 'stale') {
      this.metrics?.record(identity ? 'history.stale' : 'history.unverified');
      return null;
    }
    let selected: { part: DuplicateFingerprint; hash: string; count: number } | null = null;
    patterns.forEach((pattern, index) => {
      const count = sharedImageKeys
        ? (mutation.counts[0] ?? 0) >= 2
          ? (mutation.counts[1] ?? 0)
          : 0
        : (mutation.counts[index] ?? 0);
      if (count > flow.allowedCount + 1 && (!selected || count > selected.count))
        selected = { ...pattern, count };
    });
    if (!selected) {
      this.metrics?.record('history.no_match_or_allowed');
      return null;
    }
    this.metrics?.record('history.matched');
    const match = selected as { part: DuplicateFingerprint; hash: string; count: number };
    const binding: MessageDuplicateBinding = {
      version: mode === 'IMAGE' ? 2 : 1,
      senderId: input.userId,
      messageId: input.messageId,
      eventTimestampMs: input.eventTimestampMs,
      controlRevision: input.controlRevision,
      compareMode: mode,
      ...(input.imageScope ? { imageScope: input.imageScope } : {}),
      settingsDigest,
      sourceDigest:
        mode === 'IMAGE' ? exactImageSourceDigest(input.content) : input.content.sourceDigest,
      contentDigest: identity,
      fingerprint: match.hash,
      mediaHashes,
      mediaVersion: MESSAGE_DUPLICATE_MEDIA_VERSION,
      hasPhotos: mode !== 'TEXT' && input.content.media.some((media) => media.kind === 'photo'),
      photoControlRevision: null,
      windowSeconds: flow.windowSec,
      requiredCount: flow.allowedCount + 2,
    };
    return {
      binding,
      hit: {
        count: match.count - 1,
        windowSec: flow.windowSec,
        hash: match.hash,
        fingerprintType: match.part.type,
        metadata: { duplicateSource: 'message_v1', messageDuplicate: binding },
      },
    };
  }

  async stillMatches(chatId: string, binding: MessageDuplicateBinding): Promise<boolean> {
    const keys =
      binding.compareMode === 'IMAGE' && binding.imageScope
        ? exactImageKeys(
            chatId,
            binding.senderId,
            binding.messageId,
            binding.fingerprint,
            binding.imageScope,
          )
        : messageDuplicateKeys(chatId, binding.senderId, binding.messageId, binding.fingerprint);
    const count = await raceWithTimeout({
      operation: () =>
        this.redis.readRevisionedMembershipCount({
          ...keys,
          ...(binding.compareMode === 'IMAGE' && binding.imageScope === 'CHAT'
            ? {
                membershipKey: exactImageKeys(
                  chatId,
                  binding.senderId,
                  binding.messageId,
                  binding.fingerprint,
                  'CHAT',
                ).authorMembershipKey,
                sharedBaselineKey: keys.membershipKey,
              }
            : {}),
          revision: binding.eventTimestampMs * 2 + 1,
          scoreTimestampMs: binding.eventTimestampMs,
          windowSeconds: binding.windowSeconds,
        }),
      timeoutMs: 250,
      onTimeout: () => {
        throw new Error('Message duplicate history check timed out');
      },
    });
    return count !== null && count >= binding.requiredCount;
  }

  private buildFingerprints(content: DuplicateMessageContent, settings: ChatSettings) {
    const all = this.fingerprints.buildFingerprints(
      content.text,
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
