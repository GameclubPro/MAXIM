import { BadRequestException, Injectable } from '@nestjs/common';
import { maxUpdateSchema, type MaxUpdate } from '@maxim/contracts';
import { randomUUID } from 'node:crypto';

@Injectable()
export class WebhookParser {
  parse(payload: Record<string, unknown>): MaxUpdate {
    const message = (payload.message as Record<string, unknown> | undefined) ?? undefined;
    const chatTitle = this.extractChatTitle(message);

    const normalized: MaxUpdate = {
      updateId: String(payload.updateId ?? payload.update_id ?? payload.eventId ?? randomUUID()),
      type: String(payload.type ?? payload.event_type ?? 'unknown'),
      message:
        message &&
        (message.text || message.message_id || message.messageId || message.chat_id || message.chatId)
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
              text: String(message.text ?? ''),
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
}
