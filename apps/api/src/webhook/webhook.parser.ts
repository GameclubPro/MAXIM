import { BadRequestException, Injectable } from '@nestjs/common';
import { maxUpdateSchema, type MaxUpdate } from '@maxim/contracts';
import { randomUUID } from 'node:crypto';

@Injectable()
export class WebhookParser {
  parse(payload: Record<string, unknown>): MaxUpdate {
    const message = (payload.message as Record<string, unknown> | undefined) ?? undefined;
    const chatTitle = this.extractChatTitle(message);
    const messageText = this.extractMessageText(message);

    const normalized: MaxUpdate = {
      updateId: String(payload.updateId ?? payload.update_id ?? payload.eventId ?? randomUUID()),
      type: String(payload.type ?? payload.event_type ?? 'unknown'),
      message:
        message &&
        (messageText || message.message_id || message.messageId || message.chat_id || message.chatId)
          ? {
              messageId: String(message.messageId ?? message.message_id ?? message.id ?? ''),
              chatId: String(message.chatId ?? message.chat_id ?? ''),
              ...(chatTitle ? { chatTitle } : {}),
              senderId: String(
                message.senderId ??
                  message.sender_id ??
                  (message.sender as Record<string, unknown> | undefined)?.id ??
                  '',
              ),
              text: messageText,
              createdAt: new Date(
                String(message.createdAt ?? message.created_at ?? payload.timestamp ?? Date.now()),
              ).toISOString(),
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

  private extractChatTitle(message: Record<string, unknown> | undefined): string | undefined {
    if (!message) {
      return undefined;
    }

    const recipient = (message.recipient as Record<string, unknown> | undefined) ?? undefined;
    const chat = (message.chat as Record<string, unknown> | undefined) ?? undefined;
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

    const body = (message.body as Record<string, unknown> | undefined) ?? undefined;
    const content = (message.content as Record<string, unknown> | undefined) ?? undefined;
    const payload = (message.payload as Record<string, unknown> | undefined) ?? undefined;
    const messageNode = (message.message as Record<string, unknown> | undefined) ?? undefined;

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
}
