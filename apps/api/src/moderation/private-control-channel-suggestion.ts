import { BadRequestException } from '@nestjs/common';
import type { PrivateSuggestionDraft } from './private-control.types';

export function buildPrivateChannelSuggestionSubmissionPayload(draft: PrivateSuggestionDraft) {
  return {
    token: draft.token,
    text: draft.text,
    ...(draft.textMarkup.length > 0 ? { textMarkup: draft.textMarkup } : {}),
    ...(draft.textMarkup.length === 0 && draft.textFormat === 'markdown'
      ? { textFormat: draft.textFormat }
      : {}),
    ...(draft.images.length > 0
      ? {
          images: draft.images.map((image) => ({
            payload: image.payload,
            mimeType: image.mimeType || null,
            fileName: image.fileName || null,
          })),
        }
      : draft.video
        ? {
            mediaType: draft.video.kind,
            mediaPayload: draft.video.payload,
            mediaMimeType: draft.video.mimeType || null,
            mediaFileName: draft.video.fileName || null,
          }
        : draft.imageBase64
          ? {
              imageBase64: draft.imageBase64,
              imageMimeType: draft.imageMimeType || null,
              imageFileName: draft.imageFileName || null,
            }
          : {}),
  };
}

export function assertPrivateSuggestionMediaBot(
  draft: PrivateSuggestionDraft | null | undefined,
  currentBotId: string | null | undefined,
): void {
  if (!draft || !hasBotScopedDraftMedia(draft)) return;
  const storedBotId = draft.mediaBotId?.trim() ?? '';
  const normalizedCurrentBotId = currentBotId?.trim() ?? '';
  if (storedBotId && normalizedCurrentBotId === storedBotId) return;
  throw new BadRequestException(
    'Медиа этой предложки загружено другим ботом. Вернитесь к исходному боту или создайте новую предложку.',
  );
}

export function assertPrivateSuggestionMediaCaptureBot(
  hasIncomingMedia: boolean,
  currentBotId: string | null | undefined,
): void {
  if (!hasIncomingMedia || currentBotId?.trim()) return;
  throw new BadRequestException(
    'Не удалось определить бота, который загружает медиа. Откройте предложку заново.',
  );
}

function hasBotScopedDraftMedia(draft: PrivateSuggestionDraft): boolean {
  const hasToken = (payload: Record<string, unknown>) =>
    typeof payload.token === 'string' && payload.token.trim().length > 0;
  return (
    draft.images.some((image) => hasToken(image.payload)) ||
    Boolean(draft.video && hasToken(draft.video.payload))
  );
}
