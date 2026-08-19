import type { BroadcastImage } from '@maxim/contracts';
import type {
  ManagedPollDetails,
  ManagedPollQuestionFormat,
  ManagedPollVisibility,
} from '@maxim/contracts/poll';
import { getApiErrorStatus } from './api-retry';

export type ManagedPollDraftOption = {
  key: string;
  id?: string;
  text: string;
};

export type ManagedPollEditorDraft = {
  pollId: string | null;
  expectedUpdatedAt: string | null;
  question: string;
  questionFormat: ManagedPollQuestionFormat;
  images: BroadcastImage[];
  imageRevision: number;
  visibility: ManagedPollVisibility;
  options: ManagedPollDraftOption[];
};

export function isManagedPollEditConflict(error: unknown): boolean {
  return getApiErrorStatus(error) === 409;
}

export function rebaseManagedPollDraftAfterConflict(
  localDraft: ManagedPollEditorDraft,
  latestPoll: ManagedPollDetails,
): ManagedPollEditorDraft {
  const latestOptionIds = new Set(latestPoll.options.map((option) => option.id));

  return {
    pollId: latestPoll.id,
    expectedUpdatedAt: latestPoll.updatedAt,
    question: localDraft.question,
    questionFormat: localDraft.questionFormat,
    images: localDraft.images.map((image) => ({ ...image })),
    imageRevision: localDraft.imageRevision,
    visibility: localDraft.visibility,
    options: localDraft.options.map((option) => ({
      key: option.key,
      ...(option.id && latestOptionIds.has(option.id) ? { id: option.id } : {}),
      text: option.text,
    })),
  };
}
