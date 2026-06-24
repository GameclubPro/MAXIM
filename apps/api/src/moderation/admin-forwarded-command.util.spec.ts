import { BadRequestException } from '@nestjs/common';
import type { MaxUpdate } from '@maxim/contracts';
import {
  dedupeForwardedModerationTargets,
  extractDirectIncomingMessageText,
  extractForwardedModerationTargets,
  extractForwardedRulesSources,
  getAdminCommandName,
  parseAdminForwardedModerationCommand,
} from './admin-forwarded-command.util';

function createCommandUpdate(params: {
  text?: string;
  forwardedChatId?: string | number;
  forwardedMessageId?: string | number;
  forwardedUserId?: string | number;
} = {}): MaxUpdate {
  const text = params.text ?? 'бан';
  const forwardedChatId = params.forwardedChatId ?? 'chat-1';
  const forwardedMessageId = params.forwardedMessageId ?? 'mid-forward-1';
  const forwardedUserId = params.forwardedUserId ?? 'user-2';
  return {
    updateId: 'upd-admin-forward-1',
    type: 'message_created',
    message: {
      messageId: 'msg-admin-forward-1',
      chatId: 'chat-1',
      senderId: 'admin-1',
      senderName: 'Админ',
      text,
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        sender: {
          user_id: 'admin-1',
          display_name: 'Админ',
        },
        recipient: {
          chat_id: 'chat-1',
        },
        body: {
          text,
          forwarded_message: {
            sender: {
              user_id: forwardedUserId,
              display_name: 'Нарушитель',
            },
            recipient: {
              chat_id: forwardedChatId,
              title: forwardedChatId === 'chat-1' ? 'Chat 1' : 'Другой чат',
            },
            body: {
              mid: forwardedMessageId,
              text: 'spam message',
            },
          },
        },
      },
    },
  };
}

function createReplyUpdate(text = 'мут'): MaxUpdate {
  return {
    updateId: 'upd-admin-reply-1',
    type: 'message_created',
    message: {
      messageId: 'msg-admin-reply-1',
      chatId: 'chat-1',
      senderId: 'admin-1',
      senderName: 'Админ',
      text,
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        sender: {
          user_id: 'admin-1',
          display_name: 'Админ',
        },
        recipient: {
          chat_id: 'chat-1',
        },
        link: {
          type: 'reply',
          sender: {
            user_id: 'user-2',
            first_name: 'Иван',
            last_name: 'Петров',
          },
          message: {
            mid: 'mid-reply-target-1',
            text: 'spam reply',
          },
        },
        body: {
          text,
        },
      },
    },
  };
}

function createRulesUpdate(text = 'правило'): MaxUpdate {
  return {
    updateId: 'upd-admin-rules-1',
    type: 'message_created',
    message: {
      messageId: 'msg-admin-rules-1',
      chatId: 'chat-1',
      senderId: 'admin-1',
      senderName: 'Админ',
      text,
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        body: {
          text,
          forwarded_message: {
            recipient: {
              chat_id: 'chat-1',
              title: 'Chat 1',
            },
            body: {
              mid: 'mid-rules-source-1',
              text: '1. Без спама.',
            },
          },
        },
      },
    },
  };
}

describe('admin forwarded command util', () => {
  it('parses built-in and custom moderation commands', () => {
    expect(parseAdminForwardedModerationCommand('БаН!')).toEqual({
      action: 'BAN',
      fanoutAllChats: true,
    });
    expect(parseAdminForwardedModerationCommand('мут 12ч')).toEqual({
      action: 'MUTE',
      muteDurationHours: 12,
    });
    expect(parseAdminForwardedModerationCommand('мут 88')).toEqual({
      action: 'MUTE',
      mutePermanent: true,
    });
    expect(parseAdminForwardedModerationCommand('super-ban.')).toEqual({
      action: 'SUPER_BAN',
    });
    expect(parseAdminForwardedModerationCommand('регламент', { adminRulesCommandName: 'Регламент' }))
      .toEqual({
        action: 'RULES',
      });
    expect(
      parseAdminForwardedModerationCommand('открыть', {
        adminOpenChatCommandName: 'Открыть',
      }),
    ).toEqual({
      action: 'OPEN_CHAT',
    });
  });

  it('rejects obsolete ban durations and invalid mute/silence durations', () => {
    expect(() => parseAdminForwardedModerationCommand('бан 24')).toThrow(BadRequestException);
    expect(() => parseAdminForwardedModerationCommand('мут 999')).toThrow(BadRequestException);
    expect(() => parseAdminForwardedModerationCommand('тишина 0')).toThrow(BadRequestException);
  });

  it('normalizes configured command labels', () => {
    expect(getAdminCommandName('  Бан   Везде ', 'бан')).toBe('бан везде');
    expect(getAdminCommandName(null, 'бан')).toBe('бан');
  });

  it('extracts direct command text from the normalized message or raw payload', () => {
    expect(extractDirectIncomingMessageText(createCommandUpdate({ text: 'мут' }))).toBe('мут');
    const update = createCommandUpdate({ text: 'бан' });
    update.message!.text = '';
    expect(extractDirectIncomingMessageText(update)).toBe('бан');
  });

  it('extracts and deduplicates forwarded moderation targets', () => {
    const targets = extractForwardedModerationTargets(createCommandUpdate());
    expect(targets).toEqual([
      {
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
        userId: 'user-2',
        senderName: 'Нарушитель',
        messageId: 'mid-forward-1',
      },
    ]);

    expect(
      dedupeForwardedModerationTargets([
        {
          chatId: 'chat-1',
          chatTitle: null,
          userId: 'user-2',
          senderName: null,
          messageId: null,
        },
        {
          chatId: 'chat-1',
          chatTitle: null,
          userId: 'user-2',
          senderName: null,
          messageId: 'mid-later',
        },
      ]),
    ).toEqual([
      {
        chatId: 'chat-1',
        chatTitle: null,
        userId: 'user-2',
        senderName: null,
        messageId: 'mid-later',
      },
    ]);
  });

  it('uses the current chat as fallback for reply-linked moderation targets', () => {
    expect(extractForwardedModerationTargets(createReplyUpdate(), 'chat-1')).toEqual([
      {
        chatId: 'chat-1',
        chatTitle: null,
        userId: 'user-2',
        senderName: 'Иван Петров',
        messageId: 'mid-reply-target-1',
      },
    ]);
  });

  it('extracts forwarded rules sources separately from moderation targets', () => {
    expect(extractForwardedRulesSources(createRulesUpdate())).toEqual([
      {
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
        messageId: 'mid-rules-source-1',
        url: null,
        text: '1. Без спама.',
      },
    ]);
  });
});
