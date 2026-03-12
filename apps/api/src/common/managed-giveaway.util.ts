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
