import type { ApiTransport } from './transport';
import { markPreviewApiPrincipal } from './preview-principal';
import { handleAutopostsPreviewRequest } from './preview-transport-autoposts';
import { handleDialogPreviewRequest } from './preview-transport-dialog';
import { handleEventsPreviewRequest } from './preview-transport-events';
import { handleGiveawaysPreviewRequest } from './preview-transport-giveaways';
import { handlePublicationsPreviewRequest } from './preview-transport-publications';
import {
  dispatchPreviewRequest,
  type PreviewApiTransportOptions,
  type PreviewRequestHandler,
} from './preview-transport-runtime';
import { handleSettingsPreviewRequest } from './preview-transport-settings';
import { createPreviewState } from './preview-transport-state';
import { handleSystemPreviewRequest } from './preview-transport-system';
import { handleVkPreviewRequest } from './preview-transport-vk';

export type { PreviewApiTransportOptions, PreviewClock } from './preview-transport-runtime';

export const PREVIEW_REQUEST_HANDLERS: readonly PreviewRequestHandler[] = [
  handleSystemPreviewRequest,
  handlePublicationsPreviewRequest,
  handleAutopostsPreviewRequest,
  handleGiveawaysPreviewRequest,
  handleDialogPreviewRequest,
  handleVkPreviewRequest,
  handleEventsPreviewRequest,
  handleSettingsPreviewRequest,
];

export function createPreviewApiTransport(options: PreviewApiTransportOptions = {}): ApiTransport {
  const state = createPreviewState(options);

  const request: ApiTransport['request'] = async (requestPath, init = {}) => {
    const url = new URL(requestPath, 'https://preview.local');
    return dispatchPreviewRequest(
      {
        state,
        url,
        segments: url.pathname.split('/').filter(Boolean),
        method: (init.method ?? 'GET').toUpperCase(),
        init,
      },
      PREVIEW_REQUEST_HANDLERS,
    );
  };

  const api: ApiTransport = {
    request,
    requestKeepalive(requestPath, init = {}) {
      void request(requestPath, init).catch((error: unknown) => {
        try {
          options.onKeepaliveError?.(error);
        } catch {
          // Keepalive callers cannot observe errors; never create a secondary unhandled rejection.
        }
      });
    },
  };

  return markPreviewApiPrincipal(api, state.me.userId);
}
