import { createHash } from 'node:crypto';
import type { UpdateManagedGiveawayRequest } from '@maxim/contracts';

export function normalizeManagedGiveawayDraft(
  payload: UpdateManagedGiveawayRequest,
): UpdateManagedGiveawayRequest {
  return {
    ...payload,
    title: payload.title.trim(),
    description: payload.description.trim(),
    imageBase64: payload.imageEnabled ? payload.imageBase64.trim() : '',
    imageMimeType: payload.imageEnabled ? payload.imageMimeType.trim() : '',
    imageFileName: payload.imageEnabled ? payload.imageFileName.trim() : '',
    requiredChannelIds: Array.from(
      new Set(
        payload.requiredChannelIds
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      ),
    ),
    prizes: payload.prizes
      .map((prize) => ({
        position: Math.max(1, Math.trunc(prize.position)),
        title: prize.title.trim(),
      }))
      .sort((left, right) => left.position - right.position),
  };
}

export function buildManagedGiveawayDrawRank(drawSeed: string, userId: string): string {
  return createHash('sha256')
    .update(`${drawSeed.trim()}:${userId.trim()}`)
    .digest('hex');
}

export function formatManagedGiveawayPrizeList(
  prizes: Array<{
    position: number;
    title: string;
  }>,
): string[] {
  return prizes
    .slice()
    .sort((left, right) => left.position - right.position)
    .map((prize) => `${prize.position}. ${prize.title.trim()}`);
}
