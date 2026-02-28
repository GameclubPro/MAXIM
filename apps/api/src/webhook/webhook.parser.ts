import { BadRequestException, Injectable } from '@nestjs/common';
import { maxUpdateSchema, type MaxUpdate } from '@maxim/contracts';
import { randomUUID } from 'node:crypto';

@Injectable()
export class WebhookParser {
  parse(payload: Record<string, unknown>): MaxUpdate {
    const type = this.extractUpdateType(payload);
    const message = this.extractMessageNode(payload, type);
    const messageId = this.extractMessageId(message, payload);
    const chatId = this.extractChatId(message, payload);
    const senderId = this.extractSenderId(message, payload);
    const chatTitle = this.extractChatTitle(message);
    const messageText = this.extractMessageText(message);
    const createdAt = this.extractCreatedAt(message, payload);
    const hasMessage = Boolean(message && messageId && chatId && senderId);

    const normalized: MaxUpdate = {
      updateId: String(
        payload.updateId ?? payload.update_id ?? payload.eventId ?? payload.event_id ?? randomUUID(),
      ),
      type,
      message:
        hasMessage
          ? {
              messageId,
              chatId,
              ...(chatTitle ? { chatTitle } : {}),
              senderId,
              text: messageText,
              createdAt,
            }
          : undefined,
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

  private extractMessageNode(
    payload: Record<string, unknown>,
    type: string,
  ): Record<string, unknown> | undefined {
    const directMessage = this.asRecord(payload.message);
    if (directMessage) {
      return directMessage;
    }

    const envelopeKeys = [type, payload.update_type, payload.event_type, payload.type, 'data', 'event'];
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
    if (!message) {
      return '';
    }

    const body = this.asRecord(message.body);
    const data = this.asRecord(message.data);

    const candidates = [
      message.messageId,
      message.message_id,
      message.id,
      body?.mid,
      body?.seq,
      body?.message_id,
      body?.messageId,
      body?.id,
      data?.message_id,
      data?.messageId,
      data?.id,
      payload.message_id,
      payload.messageId,
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
    if (!message) {
      return '';
    }

    const chat = this.asRecord(message.chat);
    const recipient = this.asRecord(message.recipient);
    const conversation = this.asRecord(message.conversation);
    const payloadChat = this.asRecord(payload.chat);

    const candidates = [
      message.chatId,
      message.chat_id,
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

  private extractCreatedAt(
    message: Record<string, unknown> | undefined,
    payload: Record<string, unknown>,
  ): string {
    const candidates = [
      message?.createdAt,
      message?.created_at,
      message?.timestamp,
      payload.timestamp,
      payload.created_at,
      payload.createdAt,
    ];

    for (const value of candidates) {
      if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
        continue;
      }

      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) {
        return date.toISOString();
      }
    }

    return new Date().toISOString();
  }

  private extractChatTitle(message: Record<string, unknown> | undefined): string | undefined {
    if (!message) {
      return undefined;
    }

    const recipient = this.asRecord(message.recipient);
    const chat = this.asRecord(message.chat);
    const candidates = [
      message.chatTitle,
      message.chat_title,
      message.chatName,
      message.chat_name,
      chat?.title,
      chat?.name,
      recipient?.title,
      recipient?.chat_title,
      recipient?.chatTitle,
      recipient?.name,
      recipient?.display_name,
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
      message.message_text,
      message.messageText,
      body?.text,
      body?.plain,
      content?.text,
      content?.caption,
      payload?.text,
      messageNode?.text,
    ];

    for (const value of directCandidates) {
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }

    const urls = this.collectUrlsFromNode(message, new Set<string>());
    if (urls.length > 0) {
      return urls.join(' ');
    }

    return '';
  }

  private collectUrlsFromNode(node: unknown, acc: Set<string>, depth = 0): string[] {
    if (depth > 8 || node === null || node === undefined) {
      return [...acc];
    }

    if (typeof node === 'string') {
      for (const url of this.extractUrlsFromString(node)) {
        acc.add(url);
      }
      return [...acc];
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        this.collectUrlsFromNode(item, acc, depth + 1);
      }
      return [...acc];
    }

    if (typeof node === 'object') {
      const row = node as Record<string, unknown>;
      for (const [key, value] of Object.entries(row)) {
        if (typeof value === 'string') {
          const urls = this.extractUrlsFromString(value);
          for (const url of urls) {
            acc.add(url);
          }
        } else if (value && (typeof value === 'object' || Array.isArray(value))) {
          this.collectUrlsFromNode(value, acc, depth + 1);
        }

        if (typeof value === 'string' && /(url|href|link)$/i.test(key)) {
          const urls = this.extractUrlsFromString(value);
          for (const url of urls) {
            acc.add(url);
          }
        }
      }
    }

    return [...acc];
  }

  private extractUrlsFromString(value: string): string[] {
    if (!value || value.trim().length === 0) {
      return [];
    }

    const regex = /((https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,})(\/\S*)?/gi;
    return [...value.matchAll(regex)]
      .map((match) => match[0].trim().replace(/[),.;!?]+$/, ''))
      .filter((url) => url.length > 0);
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
}
