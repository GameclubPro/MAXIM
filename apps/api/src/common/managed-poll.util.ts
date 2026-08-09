import { type ManagedPollQuestionFormat } from '@maxim/contracts/poll';
import type { MaxMessageButton } from '../max/max-client.service';
import { measureMaxInlineKeyboardTextWeight } from '../max/max-inline-keyboard-layout';
import { renderSupportedMarkdownAsHtml } from './max-markdown.util';

export const MANAGED_POLL_CALLBACK_PREFIX = 'poll';
const MANAGED_POLL_CALLBACK_VERSION = 'v2';
const MANAGED_POLL_PROGRESS_CELLS = 10;
const MANAGED_POLL_BUTTON_MAX_VISUAL_WEIGHT = 36;

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
  questionFormat?: ManagedPollQuestionFormat;
}): string {
  return params.questionFormat === 'markdown'
    ? renderSupportedMarkdownAsHtml(params.question.trim(), { blockMode: 'raw' })
    : params.question.trim();
}

export function buildManagedPollButtons(
  pollId: string,
  options: readonly ManagedPollOptionResult[],
): MaxMessageButton[][] {
  return options.map((option) => [
    {
      type: 'callback',
      text: buildManagedPollButtonText(option),
      payload: buildManagedPollCallbackPayload(pollId, option.id),
    },
  ]);
}

function buildManagedPollButtonText(option: ManagedPollOptionResult): string {
  const percent = Math.max(0, Math.min(100, Math.trunc(option.percent)));
  const votes = Math.max(0, Math.trunc(option.votes));
  const result = `${percent}%(${votes})`;
  const filledCells = Math.round((percent / 100) * MANAGED_POLL_PROGRESS_CELLS);
  const progress = `${'█'.repeat(filledCells)}${'░'.repeat(
    MANAGED_POLL_PROGRESS_CELLS - filledCells,
  )}`;
  const normalizedOptionText = option.text.trim().replace(/\s+/gu, ' ');
  const progressSuffix = `  ${progress} ${result}`;
  const progressLabelWeight = Math.round(
    measureMaxInlineKeyboardTextWeight(`${normalizedOptionText}${progressSuffix}`) * 10,
  );
  if (progressLabelWeight <= MANAGED_POLL_BUTTON_MAX_VISUAL_WEIGHT * 10) {
    return `${normalizedOptionText}${progressSuffix}`;
  }

  return `${normalizedOptionText}  ${result}`;
}

export function buildManagedPollCallbackPayload(pollId: string, optionId: string): string {
  return [
    MANAGED_POLL_CALLBACK_PREFIX,
    MANAGED_POLL_CALLBACK_VERSION,
    pollId.trim(),
    optionId.trim(),
  ].join('|');
}

export function buildManagedPollCallbackPayloadPrefix(pollId: string): string {
  return [MANAGED_POLL_CALLBACK_PREFIX, MANAGED_POLL_CALLBACK_VERSION, pollId.trim(), ''].join('|');
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
