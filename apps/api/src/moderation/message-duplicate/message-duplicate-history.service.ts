import { Injectable } from '@nestjs/common';
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
import {
  buildMessageDuplicateIdentity,
  digestDuplicateContent,
  type DuplicateMessageContent,
} from './message-duplicate-content';
import {
  MESSAGE_DUPLICATE_MEDIA_VERSION,
  messageDuplicateKeys,
  messageDuplicateSettingsDigest,
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
};

@Injectable()
export class MessageDuplicateHistoryService {
  private readonly fingerprints: RuleEngineDuplicateDetector;
  constructor(private readonly redis: RedisCounterService) {
    this.fingerprints = new RuleEngineDuplicateDetector(redis);
  }

  candidateKeys(content: DuplicateMessageContent, settings: ChatSettings): string[] {
    const parts = this.fingerprints
      .buildFingerprints(content.text, settings, content.navigationTargets)
      .slice(0, 16);
    if (parts.length === 0) parts.push({ type: 'exact', value: '' });
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
    const mode = input.settings.duplicateCompareMode === 'TEXT' ? 'TEXT' : 'MESSAGE';
    const mediaHashes = [...(input.mediaHashes ?? [])];
    const identity = buildMessageDuplicateIdentity(input.content, mode, mediaHashes);
    const flow = resolveDuplicateFlowConfig(input.settings);
    const keys = messageDuplicateKeys(input.chatId, input.userId, input.messageId, '');
    const deadlineAtMs = Date.now() + 250;
    const parts = identity
      ? this.fingerprints
          .buildFingerprints(input.content.text, input.settings, input.content.navigationTargets)
          .slice(0, 16)
      : [];
    if (identity && parts.length === 0) parts.push({ type: 'exact', value: '' });
    const patterns = parts.map((part) => ({
      part,
      hash: digestDuplicateContent({
        version: 1,
        mode,
        type: part.type,
        textPresent: input.content.text.length > 0,
        value: part.value,
        actions: input.content.actions,
        media:
          mode === 'MESSAGE'
            ? input.content.media.map((media, index) => [media.kind, mediaHashes[index]])
            : [],
      }),
    }));
    const revision = input.eventTimestampMs * 2 + (identity ? 1 : 0);
    const mutation = await raceWithTimeout({
      operation: () =>
        this.redis.replaceRevisionedSetMembershipsBeforeDeadline({
          stateKey: keys.stateKey,
          member: keys.member,
          revision,
          scoreTimestampMs: input.eventTimestampMs,
          membershipKeys: patterns.map(
            (pattern) =>
              messageDuplicateKeys(input.chatId, input.userId, input.messageId, pattern.hash)
                .membershipKey,
          ),
          windowSeconds: flow.windowSec,
          ttlSeconds: resolveDuplicateHistoryRetentionSeconds(flow.windowSec),
          countLimit: 21,
          deadlineAtMs,
        }),
      timeoutMs: 250,
      onTimeout: () => {
        throw new Error('Message duplicate history deadline exceeded');
      },
    });
    if (mutation.kind === 'deadline_exceeded')
      throw new Error('Message duplicate history deadline exceeded');
    if (!identity || mutation.kind === 'stale') return null;
    let selected: { part: DuplicateFingerprint; hash: string; count: number } | null = null;
    patterns.forEach((pattern, index) => {
      const count = mutation.counts[index] ?? 0;
      if (count > flow.allowedCount + 1 && (!selected || count > selected.count))
        selected = { ...pattern, count };
    });
    if (!selected) return null;
    const match = selected as { part: DuplicateFingerprint; hash: string; count: number };
    const binding: MessageDuplicateBinding = {
      version: 1,
      senderId: input.userId,
      messageId: input.messageId,
      eventTimestampMs: input.eventTimestampMs,
      controlRevision: input.controlRevision,
      compareMode: mode,
      settingsDigest: messageDuplicateSettingsDigest(input.settings),
      sourceDigest: input.content.sourceDigest,
      contentDigest: identity,
      fingerprint: match.hash,
      mediaHashes,
      mediaVersion: MESSAGE_DUPLICATE_MEDIA_VERSION,
      hasPhotos: mode === 'MESSAGE' && input.content.media.some((media) => media.kind === 'photo'),
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
    const keys = messageDuplicateKeys(
      chatId,
      binding.senderId,
      binding.messageId,
      binding.fingerprint,
    );
    const count = await raceWithTimeout({
      operation: () =>
        this.redis.readRevisionedMembershipCount({
          ...keys,
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
}
