import { BadRequestException, Injectable } from '@nestjs/common';
import { maxUpdateSchema, type MaxUpdate } from '@maxim/contracts';
import { createHash } from 'node:crypto';
import {
  extractUrlsFromText as extractTextUrls,
  stripUrlsFromText as stripTextUrls,
} from '../common/url-text.util';
import { resolveMaxUserDisplayName } from '../common/max-user-display-name.util';

@Injectable()
export class WebhookParser {
  parse(payload: Record<string, unknown>, options: { botId?: string } = {}): MaxUpdate {
    const type = this.extractUpdateType(payload);
    const updateId = String(
      payload.updateId ??
        payload.update_id ??
        payload.eventId ??
        payload.event_id ??
        this.buildSyntheticUpdateId(type, payload),
    );
    const message = this.extractMessageNode(payload, type);
    const messageId = this.extractMessageId(message, payload);
    const chatId = this.extractChatId(message, payload);
    const senderId = this.extractSenderId(message, payload);
    const senderName = this.extractSenderName(message, payload);
    const chatTitle = this.extractChatTitle(message, payload);
    const messageText = this.extractMessageText(message);
    const eventTimestamp = this.extractEventTimestamp(type, message, payload);
    const membershipPayload = this.extractMembershipPayload(payload, type);
    const membershipChatId = this.extractMembershipChatId(membershipPayload);
    const membershipSenderId = this.extractMembershipSenderId(membershipPayload);
    const membershipSenderName = this.extractMembershipSenderName(membershipPayload);
    const membershipInviterId = this.extractMembershipInviterId(membershipPayload, payload);
    const chatEntityType = this.extractChatEntityType(message, payload, membershipPayload);
    const resolvedMessageId =
      messageId ||
      (this.isSyntheticMessageUpdateType(type) || this.isPureForwardMessageCreated(type, message)
        ? `${type}:${updateId}`
        : '');
    const resolvedChatId = chatId || membershipChatId;
    const resolvedSenderId = senderId || membershipSenderId;
    const resolvedSenderName = senderName ?? membershipSenderName;
    const membership = this.extractMembershipChange(
      payload,
      type,
      message,
      resolvedSenderId,
      membershipInviterId,
    );
    const hasMessage =
      Boolean(message && resolvedMessageId && resolvedChatId) ||
      Boolean(this.isSyntheticMessageUpdateType(type) && resolvedChatId);

    const normalized: MaxUpdate = {
      updateId,
      ...(options.botId ? { botId: options.botId } : {}),
      eventTimestampSource: eventTimestamp.source,
      type,
      message: hasMessage
        ? {
            messageId: resolvedMessageId,
            chatId: resolvedChatId,
            ...(chatTitle ? { chatTitle } : {}),
            ...(chatEntityType ? { entityType: chatEntityType } : {}),
            senderId: resolvedSenderId,
            ...(resolvedSenderName ? { senderName: resolvedSenderName } : {}),
            text: messageText,
            createdAt: eventTimestamp.value,
          }
        : undefined,
      ...(membership ? { membership } : {}),
      raw: payload,
    };

    const parsed = maxUpdateSchema.safeParse(normalized);
    if (!parsed.success) {
      throw new BadRequestException('Invalid webhook payload format');
    }

    return parsed.data;
  }

  private extractUpdateType(payload: Record<string, unknown>): string {
    const value = payload.type ?? payload.update_type ?? payload.event_type ?? 'unknown';
    return String(value);
  }

  private buildSyntheticUpdateId(type: string, payload: Record<string, unknown>): string {
    const canonicalPayload = this.stableStringify(payload);
    const digest = createHash('sha256').update(canonicalPayload).digest('hex');
    return `synthetic:${type}:${digest}`;
  }

  private stableStringify(value: unknown): string {
    if (typeof value === 'undefined') {
      return '"[undefined]"';
    }
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value) ?? String(value);
    }

    if (Array.isArray(value)) {
      return `[${value.map((entry) => this.stableStringify(entry)).join(',')}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => {
      if (left < right) {
        return -1;
      }
      if (left > right) {
        return 1;
      }
      return 0;
    });
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${this.stableStringify(entry)}`)
      .join(',')}}`;
  }

  private isSyntheticMessageUpdateType(type: string): boolean {
    const normalized = type.trim().toLowerCase();
    return (
      normalized === 'user_added' ||
      normalized === 'bot_added' ||
      normalized === 'user_removed' ||
      normalized === 'bot_removed' ||
      normalized === 'bot_started' ||
      normalized === 'bot_stopped' ||
      normalized === 'dialog_removed' ||
      normalized === 'message_removed' ||
      normalized === 'chat_title_changed'
    );
  }

  private isPureForwardMessageCreated(
    type: string,
    message: Record<string, unknown> | undefined,
  ): boolean {
    if (type.trim().toLowerCase() !== 'message_created' || !message || message.body !== null) {
      return false;
    }

    const link = this.asRecord(message.link);
    const linkedMessage = this.asRecord(link?.message);
    const linkedChatId = link?.chat_id ?? link?.chatId;
    const linkedMessageId = linkedMessage?.mid;
    return (
      String(link?.type ?? '')
        .trim()
        .toLowerCase() === 'forward' &&
      (typeof linkedChatId === 'string' || typeof linkedChatId === 'number') &&
      String(linkedChatId).trim().length > 0 &&
      (typeof linkedMessageId === 'string' || typeof linkedMessageId === 'number') &&
      String(linkedMessageId).trim().length > 0
    );
  }

  private extractMembershipPayload(
    payload: Record<string, unknown>,
    type: string,
  ): Record<string, unknown> | null {
    if (!this.isSyntheticMessageUpdateType(type)) {
      return null;
    }

    const data = this.asRecord(payload.data);
    const event = this.asRecord(payload.event);
    const candidates = [
      payload,
      this.asRecord(payload[type]),
      data,
      data ? this.asRecord(data[type]) : null,
      event,
      event ? this.asRecord(event[type]) : null,
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      if (this.extractMembershipChatId(candidate) || this.extractMembershipSenderId(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private extractMembershipChange(
    payload: Record<string, unknown>,
    type: string,
    message: Record<string, unknown> | undefined,
    resolvedSenderId: string,
    inviterId?: string,
  ): MaxUpdate['membership'] | undefined {
    const normalizedType = type.trim().toLowerCase();

    if (
      normalizedType === 'user_added' ||
      normalizedType === 'bot_added' ||
      normalizedType === 'user_removed' ||
      normalizedType === 'bot_removed'
    ) {
      const memberUserIds = resolvedSenderId ? [resolvedSenderId] : [];
      if (memberUserIds.length === 0) {
        return undefined;
      }

      return {
        action:
          normalizedType === 'user_removed' || normalizedType === 'bot_removed'
            ? 'removed'
            : 'added',
        memberUserIds,
        ...(inviterId && normalizedType === 'user_added' ? { inviterId } : {}),
      };
    }

    if (normalizedType !== 'message_created' || !message) {
      return undefined;
    }

    const addedMemberUserIds = this.extractMembershipCollectionUserIds(message, 'added');
    if (addedMemberUserIds.length > 0) {
      return {
        action: 'added',
        memberUserIds: addedMemberUserIds,
      };
    }

    const removedMemberUserIds = this.extractMembershipCollectionUserIds(message, 'removed');
    if (removedMemberUserIds.length > 0) {
      return {
        action: 'removed',
        memberUserIds: removedMemberUserIds,
      };
    }

    const removedMemberUserIdsFromPayload = this.extractMembershipCollectionUserIds(
      payload,
      'removed',
    );
    if (removedMemberUserIdsFromPayload.length > 0) {
      return {
        action: 'removed',
        memberUserIds: removedMemberUserIdsFromPayload,
      };
    }

    return undefined;
  }

  private extractMembershipChatId(node: Record<string, unknown> | null): string {
    if (!node) {
      return '';
    }

    const chat = this.asRecord(node.chat);
    const candidates = [node.chat_id, node.chatId, chat?.id, chat?.chat_id, chat?.chatId];

    for (const value of candidates) {
      if (typeof value === 'string' || typeof value === 'number') {
        return String(value);
      }
    }

    return '';
  }

  private extractMembershipSenderId(node: Record<string, unknown> | null): string {
    if (!node) {
      return '';
    }

    const user = this.asRecord(node.user);
    const member = this.asRecord(node.member);
    const candidates = [
      node.user_id,
      node.userId,
      node.member_id,
      node.memberId,
      user?.id,
      user?.user_id,
      user?.userId,
      member?.id,
      member?.user_id,
      member?.userId,
      member?.member_id,
      member?.memberId,
    ];

    for (const value of candidates) {
      if (typeof value === 'string' || typeof value === 'number') {
        return String(value);
      }
    }

    return '';
  }

  private extractMembershipSenderName(node: Record<string, unknown> | null): string | undefined {
    if (!node) {
      return undefined;
    }

    return (
      resolveMaxUserDisplayName(this.asRecord(node.user), this.asRecord(node.member)) ?? undefined
    );
  }

  private extractMembershipInviterId(
    membershipPayload: Record<string, unknown> | null,
    payload: Record<string, unknown>,
  ): string | undefined {
    const data = this.asRecord(payload.data);
    const event = this.asRecord(payload.event);
    const candidates = [
      membershipPayload,
      membershipPayload ? this.asRecord(membershipPayload.inviter) : null,
      membershipPayload ? this.asRecord(membershipPayload.invited_by) : null,
      data,
      data ? this.asRecord(data.inviter) : null,
      data ? this.asRecord(data.invited_by) : null,
      event,
      event ? this.asRecord(event.inviter) : null,
      event ? this.asRecord(event.invited_by) : null,
      payload,
      this.asRecord(payload.inviter),
      this.asRecord(payload.invited_by),
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const inviter = this.asRecord(candidate.inviter) ?? this.asRecord(candidate.invited_by);
      const values = [
        candidate.inviter_id,
        candidate.inviterId,
        candidate.invited_by_id,
        candidate.invitedById,
        inviter?.id,
        inviter?.user_id,
        inviter?.userId,
      ];
      for (const value of values) {
        if (typeof value === 'string' || typeof value === 'number') {
          const normalized = String(value).trim();
          if (normalized) {
            return normalized;
          }
        }
      }
    }

    return undefined;
  }

  private extractChatEntityType(
    message: Record<string, unknown> | undefined,
    payload: Record<string, unknown>,
    membershipPayload: Record<string, unknown> | null,
  ): 'chat' | 'channel' | undefined {
    const candidates = [
      message,
      this.asRecord(message?.chat),
      this.asRecord(message?.recipient),
      this.asRecord(message?.conversation),
      membershipPayload,
      this.asRecord(membershipPayload?.chat),
      this.asRecord(payload.chat),
      payload,
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const entityType = this.normalizeChatEntityType(candidate);
      if (entityType) {
        return entityType;
      }
    }

    return undefined;
  }

  private extractMembershipCollectionUserIds(
    node: unknown,
    action: 'added' | 'removed',
    depth = 0,
  ): string[] {
    if (depth > 6 || node === null || node === undefined) {
      return [];
    }

    if (Array.isArray(node)) {
      const memberUserIds = new Set<string>();
      for (const item of node) {
        for (const userId of this.extractMembershipCollectionUserIds(item, action, depth + 1)) {
          memberUserIds.add(userId);
        }
      }
      return [...memberUserIds];
    }

    const row = this.asRecord(node);
    if (!row) {
      return [];
    }

    const memberUserIds = new Set<string>();
    for (const [key, value] of Object.entries(row)) {
      const normalizedKey = key.trim().toLowerCase();
      if (!this.isMembershipCollectionKey(normalizedKey, action)) {
        continue;
      }

      for (const userId of this.collectMembershipUserIdsFromNode(value, depth + 1)) {
        memberUserIds.add(userId);
      }
    }

    return [...memberUserIds];
  }

  private collectMembershipUserIdsFromNode(node: unknown, depth = 0): string[] {
    if (depth > 6 || node === null || node === undefined) {
      return [];
    }

    if (Array.isArray(node)) {
      const memberUserIds = new Set<string>();
      for (const item of node) {
        for (const userId of this.collectMembershipUserIdsFromNode(item, depth + 1)) {
          memberUserIds.add(userId);
        }
      }
      return [...memberUserIds];
    }

    const row = this.asRecord(node);
    if (!row) {
      return [];
    }

    const directUser = this.asRecord(row.user) ?? this.asRecord(row.member);
    const directCandidates = [
      row.user_id,
      row.userId,
      row.id,
      directUser?.user_id,
      directUser?.userId,
      directUser?.id,
    ];

    for (const candidate of directCandidates) {
      if (typeof candidate === 'string' || typeof candidate === 'number') {
        return [String(candidate)];
      }
    }

    const memberUserIds = new Set<string>();
    for (const value of Object.values(row)) {
      for (const userId of this.collectMembershipUserIdsFromNode(value, depth + 1)) {
        memberUserIds.add(userId);
      }
    }

    return [...memberUserIds];
  }

  private isMembershipCollectionKey(key: string, action: 'added' | 'removed'): boolean {
    if (action === 'added') {
      return (
        key === 'new_members' ||
        key === 'new_member' ||
        key === 'members_added' ||
        key === 'member_added' ||
        key === 'added_members' ||
        key === 'added_member' ||
        key === 'joined_members' ||
        key === 'joined_member' ||
        key === 'invited_members' ||
        key === 'invited_member' ||
        key === 'new_users' ||
        key === 'new_user'
      );
    }

    return (
      key === 'removed_members' ||
      key === 'removed_member' ||
      key === 'members_removed' ||
      key === 'member_removed' ||
      key === 'left_members' ||
      key === 'left_member' ||
      key === 'leaving_members' ||
      key === 'leaving_member' ||
      key === 'departed_members' ||
      key === 'departed_member' ||
      key === 'kicked_members' ||
      key === 'kicked_member'
    );
  }

  private extractMessageNode(
    payload: Record<string, unknown>,
    type: string,
  ): Record<string, unknown> | undefined {
    const directMessage = this.asRecord(payload.message);
    if (directMessage) {
      return directMessage;
    }

    const envelopeKeys = [
      type,
      payload.update_type,
      payload.event_type,
      payload.type,
      'data',
      'event',
    ];
    for (const key of envelopeKeys) {
      if (typeof key !== 'string' || key.trim().length === 0) {
        continue;
      }

      const envelope = this.asRecord(payload[key]);
      if (!envelope) {
        continue;
      }

      const nestedMessage = this.asRecord(envelope.message);
      if (nestedMessage) {
        return nestedMessage;
      }

      const nestedData = this.asRecord(envelope.data);
      const nestedDataMessage = nestedData ? this.asRecord(nestedData.message) : undefined;
      if (nestedDataMessage) {
        return nestedDataMessage;
      }

      const bestInEnvelope = this.findBestMessageCandidate(envelope);
      if (bestInEnvelope && bestInEnvelope.score >= 4) {
        return bestInEnvelope.node;
      }
    }

    const bestInPayload = this.findBestMessageCandidate(payload);
    return bestInPayload && bestInPayload.score >= 4 ? bestInPayload.node : undefined;
  }

  private extractMessageId(
    message: Record<string, unknown> | undefined,
    payload: Record<string, unknown>,
  ): string {
    const body = this.asRecord(message?.body);
    const data = this.asRecord(message?.data);
    const content = this.asRecord(message?.content);

    const candidates = [
      message?.messageId,
      message?.message_id,
      message?.mid,
      message?.seq,
      message?.id,
      body?.mid,
      body?.seq,
      body?.message_id,
      body?.messageId,
      body?.id,
      content?.mid,
      content?.seq,
      content?.message_id,
      content?.messageId,
      content?.id,
      data?.message_id,
      data?.messageId,
      data?.id,
      payload.message_id,
      payload.messageId,
      payload.mid,
      payload.seq,
    ];

    for (const value of candidates) {
      if (typeof value === 'string' || typeof value === 'number') {
        return String(value);
      }
    }

    return '';
  }

  private extractChatId(
    message: Record<string, unknown> | undefined,
    payload: Record<string, unknown>,
  ): string {
    const chat = this.asRecord(message?.chat);
    const recipient = this.asRecord(message?.recipient);
    const conversation = this.asRecord(message?.conversation);
    const payloadChat = this.asRecord(payload.chat);
    const payloadData = this.asRecord(payload.data);
    const payloadEvent = this.asRecord(payload.event);
    const payloadDialog = this.asRecord(payload.dialog);
    const titleChanged = this.asRecord(payload.chat_title_changed);

    const candidates = [
      message?.chatId,
      message?.chat_id,
      chat?.chatId,
      chat?.chat_id,
      chat?.id,
      recipient?.chatId,
      recipient?.chat_id,
      recipient?.id,
      conversation?.chat_id,
      conversation?.chatId,
      conversation?.id,
      payload.chat_id,
      payload.chatId,
      payloadChat?.chat_id,
      payloadChat?.chatId,
      payloadChat?.id,
      payloadData?.chat_id,
      payloadData?.chatId,
      payloadEvent?.chat_id,
      payloadEvent?.chatId,
      payload.dialog_id,
      payload.dialogId,
      payloadDialog?.id,
      payloadDialog?.chat_id,
      payloadDialog?.chatId,
      titleChanged?.chat_id,
      titleChanged?.chatId,
    ];

    for (const value of candidates) {
      if (typeof value === 'string' || typeof value === 'number') {
        return String(value);
      }
    }

    return '';
  }

  private extractSenderId(
    message: Record<string, unknown> | undefined,
    payload: Record<string, unknown>,
  ): string {
    if (!message) {
      return '';
    }

    const sender = this.asRecord(message.sender);
    const from = this.asRecord(message.from);
    const user = this.asRecord(message.user);
    const actor = this.asRecord(message.actor);
    const payloadSender = this.asRecord(payload.sender);

    const candidates = [
      message.senderId,
      message.sender_id,
      sender?.id,
      sender?.user_id,
      sender?.userId,
      from?.id,
      from?.user_id,
      from?.userId,
      user?.id,
      user?.user_id,
      user?.userId,
      actor?.id,
      actor?.user_id,
      actor?.userId,
      payload.sender_id,
      payload.senderId,
      payloadSender?.id,
      payloadSender?.user_id,
      payloadSender?.userId,
    ];

    for (const value of candidates) {
      if (typeof value === 'string' || typeof value === 'number') {
        return String(value);
      }
    }

    return '';
  }

  private extractSenderName(
    message: Record<string, unknown> | undefined,
    payload: Record<string, unknown>,
  ): string | undefined {
    if (!message) {
      return undefined;
    }

    const sender = this.asRecord(message.sender);
    const from = this.asRecord(message.from);
    const user = this.asRecord(message.user);
    const actor = this.asRecord(message.actor);
    const payloadSender = this.asRecord(payload.sender);

    return (
      resolveMaxUserDisplayName(
        {
          display_name: message.display_name,
          displayName: message.displayName,
          name: message.sender_name,
          nickname: message.senderName,
        },
        sender,
        from,
        user,
        actor,
        payloadSender,
      ) ?? undefined
    );
  }

  private extractEventTimestamp(
    type: string,
    message: Record<string, unknown> | undefined,
    payload: Record<string, unknown>,
  ): { value: string; source: 'payload' | 'ingress' } {
    const data = this.asRecord(payload.data);
    const event = this.asRecord(payload.event);
    const eventCandidates = [
      payload.timestamp,
      payload.created_at,
      payload.createdAt,
      data?.timestamp,
      data?.created_at,
      data?.createdAt,
      event?.timestamp,
      event?.created_at,
      event?.createdAt,
    ];
    const candidates =
      type.trim().toLowerCase() === 'message_created'
        ? [...eventCandidates, message?.createdAt, message?.created_at, message?.timestamp]
        : eventCandidates;

    for (const value of candidates) {
      const timestampMs = this.parseWebhookTimestampMs(value);
      if (timestampMs !== null) {
        return { value: new Date(timestampMs).toISOString(), source: 'payload' };
      }
    }

    return { value: new Date().toISOString(), source: 'ingress' };
  }

  private parseWebhookTimestampMs(value: unknown): number | null {
    const parsed =
      value instanceof Date
        ? value.getTime()
        : typeof value === 'number'
          ? value
          : typeof value === 'string' && value.trim().length > 0
            ? Date.parse(value)
            : Number.NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }

    return Math.trunc(parsed < 10_000_000_000 ? parsed * 1_000 : parsed);
  }

  private extractChatTitle(
    message: Record<string, unknown> | undefined,
    payload: Record<string, unknown>,
  ): string | undefined {
    const recipient = this.asRecord(message?.recipient);
    const chat = this.asRecord(message?.chat);
    const payloadChat = this.asRecord(payload.chat);
    const payloadData = this.asRecord(payload.data);
    const payloadEvent = this.asRecord(payload.event);
    const titleChanged = this.asRecord(payload.chat_title_changed);
    const candidates = [
      message?.chatTitle,
      message?.chat_title,
      message?.chatName,
      message?.chat_name,
      message?.title,
      message?.name,
      chat?.title,
      chat?.name,
      recipient?.title,
      recipient?.chat_title,
      recipient?.chatTitle,
      recipient?.name,
      recipient?.display_name,
      payload.chat_title,
      payload.chatTitle,
      payload.title,
      payload.name,
      payloadChat?.title,
      payloadChat?.name,
      payloadData?.chat_title,
      payloadData?.chatTitle,
      payloadData?.title,
      payloadData?.name,
      payloadEvent?.chat_title,
      payloadEvent?.chatTitle,
      payloadEvent?.title,
      payloadEvent?.name,
      titleChanged?.chat_title,
      titleChanged?.chatTitle,
      titleChanged?.title,
      titleChanged?.name,
    ];

    for (const value of candidates) {
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }

    return undefined;
  }

  private extractMessageText(message: Record<string, unknown> | undefined): string {
    if (!message) {
      return '';
    }

    const body = this.asRecord(message.body);
    const content = this.asRecord(message.content);
    const payload = this.asRecord(message.payload);
    const messageNode = this.asRecord(message.message);

    const directCandidates = [
      message.text,
      message.caption,
      message.plain,
      message.message_text,
      message.messageText,
      body?.text,
      body?.caption,
      body?.plain,
      content?.text,
      content?.caption,
      content?.plain,
      payload?.text,
      payload?.caption,
      payload?.plain,
      messageNode?.text,
      messageNode?.caption,
      messageNode?.plain,
      messageNode?.message_text,
      messageNode?.messageText,
    ];

    const directSnippets: string[] = [];
    for (const value of directCandidates) {
      if (typeof value === 'string' && value.trim().length > 0) {
        directSnippets.push(value.trim());
      }
    }
    const directText = this.mergeTextSnippets(directSnippets, []).join(' ');

    const supplementalTextSnippets = this.collectSupplementalTextSnippets(message);
    const supplementalLinkUrls = this.collectSupplementalLinkUrls(message);
    const forwardedMaxMediaPreviewUrls = this.collectForwardedMaxMediaPreviewUrls(message);

    const filteredSupplementalSnippets: string[] = [];
    if (directText) {
      const knownDirectUrls = new Set(
        this.extractUrlsFromString(directText).map((url) => this.normalizeUrlForCompare(url)),
      );
      for (const snippet of supplementalTextSnippets) {
        const normalizedSnippet = snippet.replace(/\s+/g, ' ').trim();
        if (!normalizedSnippet) {
          continue;
        }

        const snippetUrls = this.extractUrlsFromString(normalizedSnippet);
        const hasNewUrl = snippetUrls.some(
          (url) => !knownDirectUrls.has(this.normalizeUrlForCompare(url)),
        );
        const snippetWithoutUrls = this.stripUrlsFromText(normalizedSnippet).trim();

        if (!hasNewUrl && snippetWithoutUrls.length === 0) {
          continue;
        }

        if (!hasNewUrl && snippetWithoutUrls.length > 0) {
          filteredSupplementalSnippets.push(snippetWithoutUrls);
          continue;
        }

        filteredSupplementalSnippets.push(normalizedSnippet);
        for (const url of snippetUrls) {
          knownDirectUrls.add(this.normalizeUrlForCompare(url));
        }
      }
    } else {
      filteredSupplementalSnippets.push(...supplementalTextSnippets);
    }

    let composedText = this.mergeTextSnippets(
      directText ? [directText] : [],
      filteredSupplementalSnippets,
    ).join(' ');
    if (supplementalLinkUrls.length === 0) {
      return this.stripForwardedMaxMediaPreviewUrls(composedText, forwardedMaxMediaPreviewUrls);
    }

    const composedUrls = new Set(
      this.extractUrlsFromString(composedText).map((url) => this.normalizeUrlForCompare(url)),
    );
    const missingUrls = supplementalLinkUrls.filter(
      (url) => !composedUrls.has(this.normalizeUrlForCompare(url)),
    );

    if (missingUrls.length === 0) {
      return this.stripForwardedMaxMediaPreviewUrls(composedText, forwardedMaxMediaPreviewUrls);
    }

    composedText = `${composedText} ${missingUrls.join(' ')}`.trim();
    return this.stripForwardedMaxMediaPreviewUrls(composedText, forwardedMaxMediaPreviewUrls);
  }

  private collectSupplementalTextSnippets(message: Record<string, unknown>): string[] {
    const body = this.asRecord(message.body);
    const content = this.asRecord(message.content);
    const payload = this.asRecord(message.payload);
    const messageNode = this.asRecord(message.message);

    const candidates: unknown[] = [
      message.markup,
      message.caption_markup,
      message.captionMarkup,
      message.attachments,
      message.link,
      message.forward,
      message.forwarded_message,
      message.forwardedMessage,
      body?.markup,
      body?.caption_markup,
      body?.captionMarkup,
      body?.attachments,
      body?.link,
      body?.forward,
      body?.forwarded_message,
      body?.forwardedMessage,
      content?.markup,
      content?.caption_markup,
      content?.captionMarkup,
      content?.attachments,
      content?.link,
      content?.forward,
      content?.forwarded_message,
      content?.forwardedMessage,
      payload?.markup,
      payload?.caption_markup,
      payload?.captionMarkup,
      payload?.attachments,
      payload?.link,
      payload?.forward,
      payload?.forwarded_message,
      payload?.forwardedMessage,
      messageNode?.link,
      messageNode?.markup,
      messageNode?.caption_markup,
      messageNode?.captionMarkup,
      messageNode?.attachments,
      messageNode?.forward,
      messageNode?.forwarded_message,
      messageNode?.forwardedMessage,
    ];

    const acc = new Set<string>();
    for (const candidate of candidates) {
      this.collectTextSnippetsFromNode(candidate, acc);
    }

    return [...acc];
  }

  private collectSupplementalLinkUrls(message: Record<string, unknown>): string[] {
    const body = this.asRecord(message.body);
    const content = this.asRecord(message.content);
    const payload = this.asRecord(message.payload);
    const messageNode = this.asRecord(message.message);
    // Direct MAX share attachments can carry the user's link only in payload.url.
    // Keep this scoped to current-message attachment collections; reply/forward previews
    // under message.link are intentionally ignored so quoted service/buttons do not moderate.
    const candidates: Array<{ node: unknown; allowShareAttachmentUrls?: boolean }> = [
      { node: message.link },
      { node: message.markup },
      { node: message.caption_markup },
      { node: message.captionMarkup },
      { node: message.attachments, allowShareAttachmentUrls: true },
      { node: body?.link },
      { node: body?.markup },
      { node: body?.caption_markup },
      { node: body?.captionMarkup },
      { node: body?.attachments, allowShareAttachmentUrls: true },
      { node: content?.link },
      { node: content?.markup },
      { node: content?.caption_markup },
      { node: content?.captionMarkup },
      { node: content?.attachments, allowShareAttachmentUrls: true },
      { node: payload?.link },
      { node: payload?.markup },
      { node: payload?.caption_markup },
      { node: payload?.captionMarkup },
      { node: payload?.attachments, allowShareAttachmentUrls: true },
      { node: messageNode?.link },
      { node: messageNode?.markup },
      { node: messageNode?.caption_markup },
      { node: messageNode?.captionMarkup },
      { node: messageNode?.attachments, allowShareAttachmentUrls: true },
    ];

    const acc = new Set<string>();
    for (const candidate of candidates) {
      this.collectLinkUrlsFromEntities(candidate.node, acc, '', 0, false, {
        allowShareAttachmentUrls: Boolean(candidate.allowShareAttachmentUrls),
      });
    }

    return [...acc];
  }

  private collectForwardedMaxMediaPreviewUrls(message: Record<string, unknown>): Set<string> {
    const urls = new Set<string>();
    this.collectForwardedMaxMediaPreviewUrlsFromNode(message, urls);
    return urls;
  }

  private collectForwardedMaxMediaPreviewUrlsFromNode(
    node: unknown,
    urls: Set<string>,
    insideForward = false,
    depth = 0,
  ): void {
    if (depth > 8 || node === null || node === undefined) {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        this.collectForwardedMaxMediaPreviewUrlsFromNode(item, urls, insideForward, depth + 1);
      }
      return;
    }

    const row = this.asRecord(node);
    if (!row) {
      return;
    }

    const type = this.readEntityType(row);
    const nestedInsideForward = insideForward || type === 'forward';
    if (nestedInsideForward && this.isMediaAttachment(row)) {
      const payload = this.asRecord(row.payload);
      const previewUrl =
        payload && typeof payload.url === 'string'
          ? this.normalizeForwardedMaxMediaPreviewUrl(payload.url)
          : null;
      if (previewUrl) {
        urls.add(previewUrl);
      }
    }

    for (const [key, value] of Object.entries(row)) {
      if (!value || (typeof value !== 'object' && !Array.isArray(value))) {
        continue;
      }

      const normalizedKey = key.toLowerCase();
      this.collectForwardedMaxMediaPreviewUrlsFromNode(
        value,
        urls,
        nestedInsideForward ||
          normalizedKey === 'forward' ||
          normalizedKey === 'forwarded_message' ||
          normalizedKey === 'forwardedmessage',
        depth + 1,
      );
    }
  }

  private isMediaAttachment(row: Record<string, unknown>): boolean {
    const payload = this.asRecord(row.payload);
    const type = this.readEntityType(row);
    const mediaType = this.readLowerString(
      row.media_type ?? row.mediaType ?? payload?.media_type ?? payload?.mediaType,
    );
    const mimeType = this.readLowerString(
      row.mime_type ?? row.mimeType ?? payload?.mime_type ?? payload?.mimeType,
    );

    return (
      type === 'image' ||
      type === 'photo' ||
      type === 'picture' ||
      type === 'video' ||
      type === 'voice' ||
      type === 'audio' ||
      type === 'audio_message' ||
      type === 'file' ||
      type === 'document' ||
      type === 'sticker' ||
      mediaType === 'image' ||
      mediaType === 'photo' ||
      mediaType === 'picture' ||
      mediaType === 'video' ||
      mediaType === 'voice' ||
      mediaType === 'audio' ||
      mediaType === 'file' ||
      mediaType === 'document' ||
      mediaType === 'sticker' ||
      mimeType?.startsWith('image/') === true ||
      mimeType?.startsWith('video/') === true ||
      mimeType?.startsWith('audio/') === true
    );
  }

  private normalizeForwardedMaxMediaPreviewUrl(value: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(value.trim());
    } catch {
      return null;
    }

    if (
      parsed.protocol.toLowerCase() !== 'https:' ||
      parsed.hostname.toLowerCase() !== 'i.oneme.ru' ||
      parsed.port.length > 0 ||
      parsed.pathname !== '/i' ||
      !parsed.searchParams.get('r')
    ) {
      return null;
    }

    return `https://i.oneme.ru/i${parsed.search}${parsed.hash}`;
  }

  private stripForwardedMaxMediaPreviewUrls(
    text: string,
    previewUrls: ReadonlySet<string>,
  ): string {
    if (!text || previewUrls.size === 0) {
      return text;
    }

    let stripped = text;
    for (const url of this.extractUrlsFromString(text)) {
      const normalizedUrl = this.normalizeForwardedMaxMediaPreviewUrl(url);
      if (normalizedUrl && previewUrls.has(normalizedUrl)) {
        stripped = stripped.replaceAll(url, '');
      }
    }

    return stripped.replace(/\s+/gu, ' ').trim();
  }

  private mergeTextSnippets(base: string[], supplemental: string[]): string[] {
    const merged: string[] = [];
    const seen = new Set<string>();

    for (const value of [...base, ...supplemental]) {
      const normalized = value.replace(/\s+/g, ' ').trim();
      if (!normalized) {
        continue;
      }

      const key = normalized.toLowerCase();
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      merged.push(normalized);
    }

    return merged;
  }

  private normalizeUrlForCompare(url: string): string {
    return url
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '');
  }

  private collectTextSnippetsFromNode(node: unknown, acc: Set<string>, parentKey = '', depth = 0) {
    if (depth > 8 || node === null || node === undefined) {
      return;
    }

    if (typeof node === 'string') {
      if (!this.isContentTextKey(parentKey)) {
        return;
      }

      const normalized = node.trim();
      if (normalized.length > 0) {
        acc.add(normalized);
      }
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        this.collectTextSnippetsFromNode(item, acc, parentKey, depth + 1);
      }
      return;
    }

    const row = this.asRecord(node);
    if (!row) {
      return;
    }

    const entityType = this.readEntityType(row);
    if (this.shouldSkipSupplementalEntity(entityType)) {
      return;
    }

    for (const [key, value] of Object.entries(row)) {
      this.collectTextSnippetsFromNode(value, acc, key, depth + 1);
    }
  }

  private collectLinkUrlsFromEntities(
    node: unknown,
    acc: Set<string>,
    parentKey = '',
    depth = 0,
    trustedLinkContext = false,
    options: { allowShareAttachmentUrls?: boolean } = {},
  ) {
    if (depth > 8 || node === null || node === undefined) {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        this.collectLinkUrlsFromEntities(
          item,
          acc,
          parentKey,
          depth + 1,
          trustedLinkContext,
          options,
        );
      }
      return;
    }

    const row = this.asRecord(node);
    if (!row) {
      return;
    }

    const type = this.readEntityType(row);
    if (this.shouldSkipSupplementalEntity(type, options)) {
      return;
    }

    const parent = parentKey.toLowerCase();
    const isDirectShareAttachment = options.allowShareAttachmentUrls === true && type === 'share';
    if (isDirectShareAttachment) {
      const payload = this.asRecord(row.payload);
      if (typeof payload?.url === 'string') {
        for (const url of this.extractUrlsFromString(payload.url)) {
          acc.add(url);
        }
      }
      return;
    }
    const isExplicitLinkEntity =
      type === 'link' ||
      type === 'url' ||
      type === 'hyperlink' ||
      parent === 'link' ||
      parent === 'links' ||
      parent === 'markup' ||
      parent === 'entity' ||
      parent === 'entities';
    const hasLinkContext = trustedLinkContext || isExplicitLinkEntity;

    if (hasLinkContext) {
      const linkCandidates = [
        row.url,
        row.href,
        row.link,
        row.link_url,
        row.linkUrl,
        row.target_url,
        row.targetUrl,
        row.uri,
      ];

      for (const candidate of linkCandidates) {
        if (typeof candidate !== 'string') {
          continue;
        }

        for (const url of this.extractUrlsFromString(candidate)) {
          acc.add(url);
        }
      }
    }

    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'string' && this.isContentTextKey(key)) {
        for (const url of this.extractUrlsFromString(value)) {
          acc.add(url);
        }
      }

      if (typeof value === 'string' && hasLinkContext && this.isLinkFieldKey(key)) {
        for (const url of this.extractUrlsFromString(value)) {
          acc.add(url);
        }
      }

      if (value && (typeof value === 'object' || Array.isArray(value))) {
        this.collectLinkUrlsFromEntities(value, acc, key, depth + 1, hasLinkContext, options);
      }
    }
  }

  private isContentTextKey(value: string): boolean {
    const key = value.toLowerCase();
    return (
      key === 'text' ||
      key === 'caption' ||
      key === 'plain' ||
      key === 'message_text' ||
      key === 'messagetext' ||
      key === 'description'
    );
  }

  private isLinkFieldKey(value: string): boolean {
    const key = value.toLowerCase();
    return (
      key === 'url' ||
      key === 'href' ||
      key === 'link' ||
      key === 'uri' ||
      key === 'link_url' ||
      key === 'linkurl' ||
      key === 'target_url' ||
      key === 'targeturl' ||
      key.endsWith('_url') ||
      key.endsWith('url')
    );
  }

  private stripUrlsFromText(value: string): string {
    return stripTextUrls(value);
  }

  private extractUrlsFromString(value: string): string[] {
    return extractTextUrls(value);
  }

  private findBestMessageCandidate(
    node: unknown,
    depth = 0,
  ): { node: Record<string, unknown>; score: number } | undefined {
    if (depth > 8 || node === null || node === undefined) {
      return undefined;
    }

    if (Array.isArray(node)) {
      let best: { node: Record<string, unknown>; score: number } | undefined;
      for (const item of node) {
        const candidate = this.findBestMessageCandidate(item, depth + 1);
        if (candidate && (!best || candidate.score > best.score)) {
          best = candidate;
        }
      }
      return best;
    }

    const row = this.asRecord(node);
    if (!row) {
      return undefined;
    }

    const currentScore = this.scoreMessageCandidate(row);
    let best: { node: Record<string, unknown>; score: number } | undefined =
      currentScore > 0 ? { node: row, score: currentScore } : undefined;

    for (const value of Object.values(row)) {
      const candidate = this.findBestMessageCandidate(value, depth + 1);
      if (candidate && (!best || candidate.score > best.score)) {
        best = candidate;
      }
    }

    return best;
  }

  private scoreMessageCandidate(row: Record<string, unknown>): number {
    let score = 0;

    if (
      typeof row.message_id === 'string' ||
      typeof row.message_id === 'number' ||
      typeof row.messageId === 'string' ||
      typeof row.messageId === 'number' ||
      typeof row.id === 'string' ||
      typeof row.id === 'number'
    ) {
      score += 2;
    }

    if (typeof row.chat_id === 'string' || typeof row.chat_id === 'number') {
      score += 3;
    }
    if (typeof row.chatId === 'string' || typeof row.chatId === 'number') {
      score += 3;
    }

    const chat = this.asRecord(row.chat);
    if (chat && (typeof chat.id === 'string' || typeof chat.id === 'number')) {
      score += 3;
    }

    const recipient = this.asRecord(row.recipient);
    if (
      recipient &&
      (typeof recipient.chat_id === 'string' ||
        typeof recipient.chat_id === 'number' ||
        typeof recipient.chatId === 'string' ||
        typeof recipient.chatId === 'number' ||
        typeof recipient.id === 'string' ||
        typeof recipient.id === 'number')
    ) {
      score += 3;
    }

    if (typeof row.sender_id === 'string' || typeof row.senderId === 'string') {
      score += 2;
    }
    const sender = this.asRecord(row.sender);
    const from = this.asRecord(row.from);
    if ((sender && typeof sender.id === 'string') || (from && typeof from.id === 'string')) {
      score += 2;
    }

    if (typeof row.text === 'string' || typeof row.caption === 'string') {
      score += 1;
    }
    if (
      typeof row.title === 'string' ||
      typeof row.chat_title === 'string' ||
      typeof row.chatTitle === 'string'
    ) {
      score += 1;
    }
    if (this.asRecord(row.body) || this.asRecord(row.content) || Array.isArray(row.attachments)) {
      score += 1;
    }

    if (
      typeof row.created_at === 'string' ||
      typeof row.createdAt === 'string' ||
      typeof row.timestamp === 'string' ||
      typeof row.timestamp === 'number'
    ) {
      score += 1;
    }

    return score;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    return value as Record<string, unknown>;
  }

  private readString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private readLowerString(value: unknown): string | undefined {
    const normalized = this.readString(value);
    if (!normalized) {
      return undefined;
    }

    return normalized.toLowerCase();
  }

  private readEntityType(row: Record<string, unknown>): string | undefined {
    return this.readLowerString(row.type ?? row.kind ?? row.entity_type ?? row.entityType);
  }

  private normalizeChatEntityType(row: Record<string, unknown>): 'chat' | 'channel' | undefined {
    const isChannel = this.readBoolean(row.is_channel ?? row.isChannel);
    const rawType = this.readLowerString(
      row.chat_type ?? row.chatType ?? row.type ?? row.kind ?? row.entity_type ?? row.entityType,
    );
    if (rawType === 'channel') {
      return 'channel';
    }
    if (
      rawType === 'chat' ||
      rawType === 'group' ||
      rawType === 'supergroup' ||
      rawType === 'dialog'
    ) {
      if (isChannel === true) {
        return 'channel';
      }
      return 'chat';
    }

    if (isChannel === true) {
      return 'channel';
    }
    if (isChannel === false) {
      return 'chat';
    }

    const link = this.readString(row.link ?? row.url ?? row.invite_link ?? row.inviteLink);
    if (link && /\/channels?\//iu.test(link)) {
      return 'channel';
    }

    return undefined;
  }

  private readBoolean(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'number') {
      if (value === 1) {
        return true;
      }
      if (value === 0) {
        return false;
      }
      return undefined;
    }

    const normalized = this.readLowerString(value);
    if (!normalized) {
      return undefined;
    }

    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false;
    }

    return undefined;
  }

  private shouldSkipSupplementalEntity(
    entityType: string | undefined,
    options: { allowShareAttachmentUrls?: boolean } = {},
  ): boolean {
    return (
      entityType === 'reply' ||
      (entityType === 'share' && !options.allowShareAttachmentUrls) ||
      entityType === 'inline_keyboard'
    );
  }
}
