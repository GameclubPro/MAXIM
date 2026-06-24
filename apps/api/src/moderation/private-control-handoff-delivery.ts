import type { PrivateContext, PrivateSession, PrivateView } from './private-control.types';
import {
  clearPrivateHandoffDelivery,
  markPrivateHandoffDelivered,
  type PrivateHandoffKind,
} from './private-control-handoff-state';

export type PrivateScreenHandoffKind = Exclude<PrivateHandoffKind, 'profileMention'>;

export type PrivateScreenHandoffDeliveryAdapters = {
  createContext(privateChatId: string): PrivateContext;
  render(context: PrivateContext, session: PrivateSession): Promise<PrivateView>;
  respond(context: PrivateContext, session: PrivateSession, view: PrivateView): Promise<void>;
  saveSession(session: PrivateSession): Promise<void>;
  onFailure(error: unknown, privateChatId: string | null): void;
};

export async function deliverPrivateScreenHandoffToKnownPrivateChat(
  session: PrivateSession,
  kind: PrivateScreenHandoffKind,
  adapters: PrivateScreenHandoffDeliveryAdapters,
): Promise<void> {
  const privateChatId = session.lastPrivateChatId;
  if (!privateChatId) {
    clearPrivateHandoffDelivery(session, kind);
    return;
  }

  try {
    const context = adapters.createContext(privateChatId);
    const view = await adapters.render(context, session);
    await adapters.respond(context, session, view);
    markPrivateHandoffDelivered(session, kind, session.lastPrivateChatId);
    await adapters.saveSession(session);
  } catch (error: unknown) {
    clearPrivateHandoffDelivery(session, kind);
    adapters.onFailure(error, session.lastPrivateChatId);
  }
}
