import {
  MANAGED_POLL_OPTION_MAX_LENGTH,
  type ManagedPollStatus,
  type ManagedPollVisibility,
} from '@maxim/contracts/poll';
import type { MaxMessageButton } from '../max/max-client.service';

export const MANAGED_POLL_CALLBACK_PREFIX = 'poll';
const MANAGED_POLL_CALLBACK_VERSION = 'v2';

export type ManagedPollOptionResult = {
  id: string;
  position: number;
  text: string;
  votes: number;
  percent: number;
};

export function buildManagedPollOptionResults(
  options: readonly { id: string; position: number; text: string }[],
  voteCounts: ReadonlyMap<string, number>,
): { totalVotes: number; options: ManagedPollOptionResult[] } {
  const normalized = [...options]
    .sort((left, right) => left.position - right.position)
    .map((option) => ({
      id: option.id.trim(),
      position: option.position,
      text: option.text.trim(),
      votes: normalizeVoteCount(voteCounts.get(option.id)),
    }));
  const totalVotes = normalized.reduce((sum, option) => sum + option.votes, 0);
  const percentages = allocateManagedPollPercentages(
    normalized.map((option) => option.votes),
    totalVotes,
  );

  return {
    totalVotes,
    options: normalized.map((option, index) => ({
      ...option,
      percent: percentages[index] ?? 0,
    })),
  };
}

export function buildManagedPollMessageText(params: {
  question: string;
  options: readonly ManagedPollOptionResult[];
  status: ManagedPollStatus;
  visibility: ManagedPollVisibility;
  totalVotes: number;
}): string {
  const title = params.status === 'CLOSED' ? 'Опрос завершён' : 'Опрос';
  const lines = [title, '', params.question.trim()];

  if (params.status === 'CLOSED') {
    lines.push('');
    for (const [index, option] of params.options.entries()) {
      lines.push(`${index + 1}. ${option.text} — ${option.votes} · ${option.percent}%`);
    }
  }

  lines.push('', buildManagedPollMeta(params.totalVotes, params.visibility));
  return lines.join('\n');
}

export function buildManagedPollButtons(
  pollId: string,
  options: readonly ManagedPollOptionResult[],
): MaxMessageButton[][] {
  return options.map((option, index) => [
    {
      type: 'callback',
      text: buildManagedPollButtonLabel(option.text, option.votes, index),
      payload: buildManagedPollCallbackPayload(pollId, option.id),
    },
  ]);
}

export function buildManagedPollCallbackPayload(pollId: string, optionId: string): string {
  return [
    MANAGED_POLL_CALLBACK_PREFIX,
    MANAGED_POLL_CALLBACK_VERSION,
    pollId.trim(),
    optionId.trim(),
  ].join('|');
}

export function parseManagedPollCallbackPayload(
  payload: string | null | undefined,
): { pollId: string; optionId: string } | null {
  if (!payload) {
    return null;
  }

  const parts = payload.trim().split('|');
  if (
    parts.length !== 4 ||
    parts[0] !== MANAGED_POLL_CALLBACK_PREFIX ||
    parts[1] !== MANAGED_POLL_CALLBACK_VERSION
  ) {
    return null;
  }

  const pollId = parts[2]?.trim() ?? '';
  const optionId = parts[3]?.trim() ?? '';
  const idPattern = /^[a-z0-9_-]{1,128}$/u;
  return idPattern.test(pollId) && idPattern.test(optionId) ? { pollId, optionId } : null;
}

function buildManagedPollMeta(totalVotes: number, visibility: ManagedPollVisibility): string {
  const visibilityLabel = visibility === 'ANONYMOUS' ? 'Анонимный' : 'Открытый';
  return `${formatManagedPollVoteCount(totalVotes)} · ${visibilityLabel}`;
}

function formatManagedPollVoteCount(value: number): string {
  const count = normalizeVoteCount(value);
  const mod100 = count % 100;
  const mod10 = count % 10;
  const suffix =
    mod100 >= 11 && mod100 <= 14
      ? 'голосов'
      : mod10 === 1
        ? 'голос'
        : mod10 >= 2 && mod10 <= 4
          ? 'голоса'
          : 'голосов';
  return `${count} ${suffix}`;
}

function buildManagedPollButtonLabel(text: string, votes: number, index: number): string {
  const suffix = ` · ${normalizeVoteCount(votes)}`;
  const fallback = `Вариант ${index + 1}`;
  const source = text.trim() || fallback;
  const maxTextLength = Math.max(1, MANAGED_POLL_OPTION_MAX_LENGTH - suffix.length);
  if (source.length <= maxTextLength) {
    return `${source}${suffix}`;
  }

  const trimmed =
    maxTextLength <= 3
      ? source.slice(0, maxTextLength)
      : `${source.slice(0, maxTextLength - 3).trimEnd()}...`;
  return `${trimmed}${suffix}`;
}

function normalizeVoteCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function allocateManagedPollPercentages(votes: readonly number[], totalVotes: number): number[] {
  if (totalVotes <= 0) {
    return votes.map(() => 0);
  }

  const shares = votes.map((value, index) => {
    const exact = (value / totalVotes) * 100;
    const floor = Math.floor(exact);
    return { index, floor, remainder: exact - floor };
  });
  let remaining = 100 - shares.reduce((sum, share) => sum + share.floor, 0);
  const ranked = [...shares].sort(
    (left, right) => right.remainder - left.remainder || left.index - right.index,
  );
  const result = shares.map((share) => share.floor);
  for (const share of ranked) {
    if (remaining <= 0) {
      break;
    }
    result[share.index] = (result[share.index] ?? 0) + 1;
    remaining -= 1;
  }
  return result;
}
