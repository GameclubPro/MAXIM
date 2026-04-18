import { normalizeMessageLimitsBlockedWordCandidate } from '@maxim/contracts';

export type MessageLimitsBlockedWordInputOperation = 'add' | 'remove';

export type MessageLimitsBlockedWordInputAction = {
  operation: MessageLimitsBlockedWordInputOperation;
  word: string;
};

export function normalizeMessageLimitsBlockedWords(values: readonly string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((item) => normalizeMessageLimitsBlockedWordCandidate(item))
        .filter((item): item is string => Boolean(item)),
    ),
  );
}

export function mergeMessageLimitsBlockedWords(
  currentWords: readonly string[],
  candidates: readonly string[],
  maxWords: number,
): {
  addedWords: string[];
  nextWords: string[];
} {
  const nextWords = normalizeMessageLimitsBlockedWords(currentWords);
  const existingWords = new Set(nextWords);
  const addedWords: string[] = [];

  for (const candidate of normalizeMessageLimitsBlockedWords(candidates)) {
    if (nextWords.length >= maxWords || existingWords.has(candidate)) {
      continue;
    }

    existingWords.add(candidate);
    nextWords.push(candidate);
    addedWords.push(candidate);
  }

  return {
    addedWords,
    nextWords,
  };
}

export function subtractMessageLimitsBlockedWords(
  currentWords: readonly string[],
  candidates: readonly string[],
): {
  nextWords: string[];
  removedWords: string[];
} {
  const removableWords = new Set(normalizeMessageLimitsBlockedWords(candidates));
  const removedWords: string[] = [];
  const nextWords = normalizeMessageLimitsBlockedWords(currentWords).filter((word) => {
    if (!removableWords.has(word)) {
      return true;
    }

    removedWords.push(word);
    return false;
  });

  return {
    nextWords,
    removedWords,
  };
}

export function parseMessageLimitsBlockedWordInputAction(
  value: string,
): MessageLimitsBlockedWordInputAction | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const operation: MessageLimitsBlockedWordInputOperation = trimmed.startsWith('-')
    ? 'remove'
    : 'add';
  const normalizedWord = normalizeMessageLimitsBlockedWordCandidate(trimmed.replace(/^[+-]+/u, ''));
  if (!normalizedWord) {
    return null;
  }

  return {
    operation,
    word: normalizedWord,
  };
}

export function splitMessageLimitsBlockedWordsInput(
  value: string,
): MessageLimitsBlockedWordInputAction[] {
  return value
    .split(/[\s,;\n]+/u)
    .map((item) => parseMessageLimitsBlockedWordInputAction(item))
    .filter((item): item is MessageLimitsBlockedWordInputAction => Boolean(item));
}

export function applyMessageLimitsBlockedWordsInput(
  currentWords: readonly string[],
  rawInput: string,
  maxWords: number,
): {
  actions: MessageLimitsBlockedWordInputAction[];
  addedWords: string[];
  nextWords: string[];
  removedWords: string[];
} {
  const actions = splitMessageLimitsBlockedWordsInput(rawInput);
  const nextWords = normalizeMessageLimitsBlockedWords(currentWords);
  const existingWords = new Set(nextWords);
  const addedWords: string[] = [];
  const removedWords: string[] = [];

  for (const action of actions) {
    if (action.operation === 'remove') {
      if (!existingWords.has(action.word)) {
        continue;
      }

      existingWords.delete(action.word);
      removedWords.push(action.word);
      const index = nextWords.indexOf(action.word);
      if (index >= 0) {
        nextWords.splice(index, 1);
      }
      continue;
    }

    if (nextWords.length >= maxWords || existingWords.has(action.word)) {
      continue;
    }

    existingWords.add(action.word);
    nextWords.push(action.word);
    addedWords.push(action.word);
  }

  return {
    actions,
    addedWords,
    nextWords,
    removedWords,
  };
}
