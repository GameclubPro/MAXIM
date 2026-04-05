import {
  MANAGED_POLL_MAX_OPTIONS,
  MANAGED_POLL_MIN_OPTIONS,
  MANAGED_POLL_OPTION_MAX_LENGTH,
  type ManagedPollStatus,
} from '@maxim/contracts';
import type { MaxMessageButton } from '../max/max-client.service';

export const MANAGED_POLL_CALLBACK_PREFIX = 'poll';

export type ManagedPollOptionSummary = {
  option: string;
  votes: number;
  percent: number;
};

export function normalizeManagedPollDraft(
  question: string,
  options: readonly string[],
): {
  question: string;
  options: string[];
} {
  const normalizedQuestion = normalizeManagedPollText(question);
  const normalizedOptions = Array.isArray(options)
    ? options
        .slice(0, MANAGED_POLL_MAX_OPTIONS)
        .map((value) => normalizeManagedPollText(value))
    : [];

  while (normalizedOptions.length < MANAGED_POLL_MIN_OPTIONS) {
    normalizedOptions.push('');
  }

  return {
    question: normalizedQuestion,
    options: normalizedOptions,
  };
}

export function validateManagedPollForPublish(
  question: string,
  options: readonly string[],
): {
  question: string;
  options: string[];
} {
  const normalized = normalizeManagedPollDraft(question, options);
  if (!normalized.question) {
    throw new Error('Сначала задайте вопрос опроса.');
  }

  if (normalized.options.some((option) => !option)) {
    throw new Error('Заполните все варианты ответа.');
  }

  const uniqueOptions = new Set(normalized.options.map((option) => normalizeManagedPollOptionKey(option)));
  if (uniqueOptions.size !== normalized.options.length) {
    throw new Error('Варианты ответа должны отличаться друг от друга.');
  }

  return normalized;
}

export function buildManagedPollOptionSummaries(
  options: readonly string[],
  voteCounts: readonly number[],
): {
  totalVotes: number;
  optionResults: ManagedPollOptionSummary[];
} {
  const normalizedOptions = normalizeManagedPollDraft('', options).options;
  const safeVoteCounts = normalizedOptions.map((_, index) => {
    const candidate = voteCounts[index];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) {
      return 0;
    }
    return Math.trunc(candidate);
  });
  const totalVotes = safeVoteCounts.reduce((sum, value) => sum + value, 0);

  return {
    totalVotes,
    optionResults: normalizedOptions.map((option, index) => ({
      option,
      votes: safeVoteCounts[index] ?? 0,
      percent:
        totalVotes > 0 ? Math.round(((safeVoteCounts[index] ?? 0) / totalVotes) * 100) : 0,
    })),
  };
}

export function buildManagedPollMessageText(
  question: string,
  optionResults: readonly ManagedPollOptionSummary[],
  status: ManagedPollStatus,
): string {
  const lines: string[] = ['Опрос', '', question.trim()];

  if (status === 'ACTIVE') {
    return lines.join('\n');
  }

  optionResults.forEach((row, index) => {
    lines.push(`${index + 1}. ${row.option} - ${row.votes} (${row.percent}%)`);
  });

  return lines.join('\n');
}

export function buildManagedPollButtons(
  pollId: string,
  version: number,
  options: readonly string[],
  optionResults?: readonly ManagedPollOptionSummary[],
): MaxMessageButton[][] {
  return normalizeManagedPollDraft('', options).options.map((option, index) => [
    {
      type: 'callback',
      text: buildManagedPollButtonLabel(option, optionResults?.[index]?.votes ?? 0, index),
      payload: buildManagedPollCallbackPayload(pollId, version, index),
    },
  ]);
}

export function buildManagedPollCallbackPayload(
  pollId: string,
  version: number,
  optionIndex: number,
): string {
  return [
    MANAGED_POLL_CALLBACK_PREFIX,
    pollId.trim(),
    String(Math.max(1, Math.trunc(version))),
    String(Math.max(0, Math.trunc(optionIndex))),
  ].join('|');
}

export function parseManagedPollCallbackPayload(
  payload: string | null,
): {
  pollId: string;
  version: number;
  optionIndex: number;
} | null {
  if (!payload) {
    return null;
  }

  const parts = payload.split('|');
  if (parts.length !== 4 || parts[0] !== MANAGED_POLL_CALLBACK_PREFIX) {
    return null;
  }

  const pollId = parts[1]?.trim();
  const version = Number.parseInt(parts[2] ?? '', 10);
  const optionIndex = Number.parseInt(parts[3] ?? '', 10);
  if (!pollId || !Number.isFinite(version) || version <= 0 || !Number.isFinite(optionIndex)) {
    return null;
  }

  return {
    pollId,
    version,
    optionIndex: Math.max(0, optionIndex),
  };
}

function normalizeManagedPollText(value: string): string {
  return value.replace(/\r/g, '').trim();
}

function normalizeManagedPollOptionKey(value: string): string {
  return normalizeManagedPollText(value).replace(/\s+/gu, ' ').toLowerCase().replace(/ё/gu, 'е');
}

function buildManagedPollButtonLabel(option: string, votes: number, index: number): string {
  const safeVotes = Math.max(0, Math.trunc(votes));
  const voteSuffix = ` (${safeVotes})`;
  const baseLabel = normalizeManagedPollText(option) || `Вариант ${index + 1}`;
  const maxBaseLength = Math.max(1, MANAGED_POLL_OPTION_MAX_LENGTH - voteSuffix.length);

  if (baseLabel.length <= maxBaseLength) {
    return `${baseLabel}${voteSuffix}`;
  }

  const truncatedBase =
    maxBaseLength <= 3
      ? baseLabel.slice(0, maxBaseLength)
      : `${baseLabel.slice(0, maxBaseLength - 3).trimEnd()}...`;

  return `${truncatedBase}${voteSuffix}`;
}
