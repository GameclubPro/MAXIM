import {
  advertisingSendInputSchema,
  advertisingSettingsInputSchema,
  type AdvertisingState,
} from '@maxim/contracts/advertising-placement';
import { PREVIEW_NOT_HANDLED, type PreviewRequestHandler } from './preview-transport-runtime';
import type { PreviewState } from './preview-transport-state';

const states = new WeakMap<PreviewState, Map<string, AdvertisingState>>();

export const handleAdvertisingPreviewRequest: PreviewRequestHandler = ({
  state,
  segments,
  method,
  init,
}) => {
  if (segments[0] !== 'chats' || segments[2] !== 'advertising-placement')
    return PREVIEW_NOT_HANDLED;
  if (!state.advertisingPilot) throw new Error('Модуль пока недоступен');
  const chatId = decodeURIComponent(segments[1]);
  const chat = state.chats.find((item) => item.id === chatId);
  if (!chat) throw new Error('Чат не найден');
  let byChat = states.get(state);
  if (!byChat) {
    byChat = new Map();
    states.set(state, byChat);
  }
  let current = byChat.get(chatId);
  if (!current) {
    const id = '10000000-0000-4000-8000-000000000001';
    const maxChatId = chatId === 'preview-chat' ? '-100' : '-101';
    current = {
      enabled: false,
      bindingCurrent: true,
      revision: 0,
      lastSend: null,
      lookupFailed: false,
      listing: {
        id,
        chatId: maxChatId,
        title: chat.title,
        url: `https://max.ru/id613000037577_3_bot?startapp=listing_${id}`,
      },
      connectUrl: `https://max.ru/id613000037577_3_bot?startapp=connect_chat_${maxChatId}`,
    };
    byChat.set(chatId, current);
  }
  if (method === 'GET') return structuredClone(current);
  const body: unknown = JSON.parse(String(init.body));
  if (method === 'PUT' && segments.length === 3) {
    const input = advertisingSettingsInputSchema.parse(body);
    if (input.revision !== current.revision) throw new Error('Настройки изменились');
    current.enabled = input.enabled;
    current.revision++;
    return structuredClone(current);
  }
  if (method === 'POST' && segments[3] === 'send') {
    const input = advertisingSendInputSchema.parse(body);
    if (current.lastSend?.id === input.requestId) return structuredClone(current.lastSend);
    if (
      !current.enabled ||
      current.revision !== input.revision ||
      (current.lastSend?.id ?? null) !== input.previousSendId
    )
      throw new Error('Настройки изменились');
    current.lastSend = {
      id: input.requestId,
      status: 'SENT',
      createdAt: state.clock.now().toISOString(),
    };
    return structuredClone(current.lastSend);
  }
  return PREVIEW_NOT_HANDLED;
};
