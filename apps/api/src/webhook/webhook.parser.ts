import { BadRequestException, Injectable } from '@nestjs/common';
import { maxUpdateSchema, type MaxUpdate } from '@maxim/contracts';
import { randomUUID } from 'node:crypto';

@Injectable()
export class WebhookParser {
  parse(payload: Record<string, unknown>): MaxUpdate {
    const message = (payload.message as Record<string, unknown> | undefined) ?? undefined;

    const normalized: MaxUpdate = {
      updateId: String(payload.updateId ?? payload.update_id ?? payload.eventId ?? randomUUID()),
      type: String(payload.type ?? payload.event_type ?? 'unknown'),
      message:
        message && (message.text || message.message_id || message.chat_id)
          ? {
              messageId: String(message.messageId ?? message.message_id ?? message.id ?? ''),
              chatId: String(message.chatId ?? message.chat_id ?? ''),
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
}
