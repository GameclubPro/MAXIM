import { createHash } from 'node:crypto';
import {
  MANAGED_GIVEAWAY_PRIZE_TITLE_MAX_LENGTH,
  type UpdateManagedGiveawayRequest,
} from '@maxim/contracts';

type NormalizedManagedGiveawayPrize = UpdateManagedGiveawayRequest['prizes'][number];

function normalizePrizeTitleKey(title: string): string {
  return title.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru-RU');
}

function appendPrizeTitleSuffix(title: string, suffixNumber: number): string {
  const suffix = ` ${suffixNumber}`;
  const maxBaseLength = Math.max(1, MANAGED_GIVEAWAY_PRIZE_TITLE_MAX_LENGTH - suffix.length);
  const base = title.trim().slice(0, maxBaseLength).trimEnd();
  return `${base}${suffix}`;
}

function uniquifyManagedGiveawayPrizeTitles(
  prizes: NormalizedManagedGiveawayPrize[],
): NormalizedManagedGiveawayPrize[] {
  const titleCounts = new Map<string, number>();
  for (const prize of prizes) {
    const key = normalizePrizeTitleKey(prize.title);
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
  }

  const reservedUniqueTitleKeys = new Set(
    [...titleCounts.entries()]
      .filter(([, count]) => count === 1)
      .map(([titleKey]) => titleKey),
  );
  const duplicateOrdinals = new Map<string, number>();
  const usedTitleKeys = new Set<string>();

  return prizes.map((prize) => {
    const title = prize.title.trim();
    const displayTitle = prize.displayTitle?.trim() || title;
    const titleKey = normalizePrizeTitleKey(title);
    const duplicateCount = titleCounts.get(titleKey) ?? 0;

    if (duplicateCount <= 1 && !usedTitleKeys.has(titleKey)) {
      usedTitleKeys.add(titleKey);
      return { ...prize, title, displayTitle };
    }

    let suffixNumber = (duplicateOrdinals.get(titleKey) ?? 0) + 1;
    duplicateOrdinals.set(titleKey, suffixNumber);

    let nextTitle = appendPrizeTitleSuffix(title, suffixNumber);
    let nextTitleKey = normalizePrizeTitleKey(nextTitle);
    while (usedTitleKeys.has(nextTitleKey) || reservedUniqueTitleKeys.has(nextTitleKey)) {
      suffixNumber += 1;
      nextTitle = appendPrizeTitleSuffix(title, suffixNumber);
      nextTitleKey = normalizePrizeTitleKey(nextTitle);
    }

    usedTitleKeys.add(nextTitleKey);
    return { ...prize, title: nextTitle, displayTitle };
  });
}

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
        payload.requiredChannelIds.map((item) => item.trim()).filter((item) => item.length > 0),
      ),
    ),
    prizes: uniquifyManagedGiveawayPrizeTitles(
      payload.prizes
        .map((prize) => ({
          position: Math.max(1, Math.trunc(prize.position)),
          title: prize.title.trim(),
          displayTitle: prize.displayTitle?.trim() || prize.title.trim(),
        }))
        .sort((left, right) => left.position - right.position),
    ),
  };
}

export function buildManagedGiveawayDrawRank(drawSeed: string, userId: string): string {
  return createHash('sha256').update(`${drawSeed.trim()}:${userId.trim()}`).digest('hex');
}

export function formatManagedGiveawayPrizeList(
  prizes: Array<{
    position: number;
    title: string;
    displayTitle?: string | null;
  }>,
): string[] {
  return prizes
    .slice()
    .sort((left, right) => left.position - right.position)
    .map((prize) => `${prize.position}. ${(prize.displayTitle?.trim() || prize.title.trim())}`);
}
