import type { PreviewState } from './preview-transport-state';

export type PreviewClock = {
  now: () => Date;
};

export type PreviewApiTransportOptions = {
  search?: string;
  clock?: PreviewClock;
  onKeepaliveError?: (error: unknown) => void;
};

export type PreviewRequestContext = {
  state: PreviewState;
  url: URL;
  segments: string[];
  method: string;
  init: RequestInit;
};

export const PREVIEW_NOT_HANDLED = Symbol('preview-not-handled');

export type PreviewRequestHandler = (
  context: PreviewRequestContext,
) => unknown | typeof PREVIEW_NOT_HANDLED | Promise<unknown | typeof PREVIEW_NOT_HANDLED>;

export const systemPreviewClock: PreviewClock = {
  now: () => new Date(),
};

export async function dispatchPreviewRequest(
  context: PreviewRequestContext,
  handlers: readonly PreviewRequestHandler[],
): Promise<unknown> {
  for (const handler of handlers) {
    const result = await handler(context);
    if (result !== PREVIEW_NOT_HANDLED) {
      return result;
    }
  }

  throw new Error(`Preview transport does not implement ${context.method} ${context.url.pathname}`);
}

export function resolvePreviewEntityRequest(context: PreviewRequestContext): {
  entityType: 'chat' | 'channel';
  entityId: string;
  tail: string[];
} | null {
  const [scope, encodedEntityId, ...tail] = context.segments;
  if ((scope !== 'chats' && scope !== 'channels') || !encodedEntityId) {
    return null;
  }
  return {
    entityType: scope === 'channels' ? 'channel' : 'chat',
    entityId: decodeURIComponent(encodedEntityId),
    tail,
  };
}

export function readPreviewClock(clock: PreviewClock): Date {
  const value = clock.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('Preview clock must return a valid Date.');
  }
  return new Date(value.getTime());
}
