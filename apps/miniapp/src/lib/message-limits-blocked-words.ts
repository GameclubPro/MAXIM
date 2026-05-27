import {
  normalizeMessageLimitsBlockedDomainCandidate,
  normalizeMessageLimitsBlockedWordCandidate,
} from '@maxim/contracts';

export type MessageLimitsBlockedWordInputOperation = 'add' | 'remove';

export type MessageLimitsBlockedWordInputAction = {
  operation: MessageLimitsBlockedWordInputOperation;
  word: string;
};

export type MessageLimitsBlockedDomainInputAction = {
  domain: string;
  operation: MessageLimitsBlockedWordInputOperation;
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

export function normalizeMessageLimitsBlockedDomains(values: readonly string[]): string[] {
  const nextDomains: string[] = [];

  for (const candidate of values
    .map((item) => normalizeMessageLimitsBlockedDomainCandidate(item))
    .filter((item): item is string => Boolean(item))) {
    if (nextDomains.some((domain) => isMessageLimitsDomainCoveredBy(candidate, domain))) {
      continue;
    }

    for (let index = nextDomains.length - 1; index >= 0; index -= 1) {
      if (isMessageLimitsDomainCoveredBy(nextDomains[index] ?? '', candidate)) {
        nextDomains.splice(index, 1);
      }
    }

    nextDomains.push(candidate);
  }

  return nextDomains;
}

function isMessageLimitsDomainCoveredBy(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.endsWith(`.${parent}`);
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

export function mergeMessageLimitsBlockedDomains(
  currentDomains: readonly string[],
  candidates: readonly string[],
  maxDomains: number,
): {
  addedDomains: string[];
  nextDomains: string[];
} {
  const nextDomains = normalizeMessageLimitsBlockedDomains(currentDomains);
  const addedDomains: string[] = [];

  for (const candidate of normalizeMessageLimitsBlockedDomains(candidates)) {
    if (nextDomains.some((domain) => isMessageLimitsDomainCoveredBy(candidate, domain))) {
      continue;
    }

    for (let index = nextDomains.length - 1; index >= 0; index -= 1) {
      if (isMessageLimitsDomainCoveredBy(nextDomains[index] ?? '', candidate)) {
        nextDomains.splice(index, 1);
      }
    }

    if (nextDomains.length >= maxDomains) {
      continue;
    }

    nextDomains.push(candidate);
    addedDomains.push(candidate);
  }

  return {
    addedDomains,
    nextDomains,
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

export function subtractMessageLimitsBlockedDomains(
  currentDomains: readonly string[],
  candidates: readonly string[],
): {
  nextDomains: string[];
  removedDomains: string[];
} {
  const removableDomains = new Set(normalizeMessageLimitsBlockedDomains(candidates));
  const removedDomains: string[] = [];
  const nextDomains = normalizeMessageLimitsBlockedDomains(currentDomains).filter((domain) => {
    if (!removableDomains.has(domain)) {
      return true;
    }

    removedDomains.push(domain);
    return false;
  });

  return {
    nextDomains,
    removedDomains,
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

export function parseMessageLimitsBlockedDomainInputAction(
  value: string,
): MessageLimitsBlockedDomainInputAction | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const operation: MessageLimitsBlockedWordInputOperation = trimmed.startsWith('-')
    ? 'remove'
    : 'add';
  const normalizedDomain = normalizeMessageLimitsBlockedDomainCandidate(
    trimmed.replace(/^[+-]+/u, ''),
  );
  if (!normalizedDomain) {
    return null;
  }

  return {
    operation,
    domain: normalizedDomain,
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

export function splitMessageLimitsBlockedDomainsInput(
  value: string,
): MessageLimitsBlockedDomainInputAction[] {
  return value
    .split(/[\s,;\n]+/u)
    .map((item) => parseMessageLimitsBlockedDomainInputAction(item))
    .filter((item): item is MessageLimitsBlockedDomainInputAction => Boolean(item));
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

export function applyMessageLimitsBlockedDomainsInput(
  currentDomains: readonly string[],
  rawInput: string,
  maxDomains: number,
): {
  actions: MessageLimitsBlockedDomainInputAction[];
  addedDomains: string[];
  nextDomains: string[];
  removedDomains: string[];
} {
  const actions = splitMessageLimitsBlockedDomainsInput(rawInput);
  const nextDomains = normalizeMessageLimitsBlockedDomains(currentDomains);
  const addedDomains: string[] = [];
  const removedDomains: string[] = [];

  for (const action of actions) {
    if (action.operation === 'remove') {
      const index = nextDomains.indexOf(action.domain);
      if (index < 0) {
        continue;
      }

      nextDomains.splice(index, 1);
      removedDomains.push(action.domain);
      continue;
    }

    if (nextDomains.some((domain) => isMessageLimitsDomainCoveredBy(action.domain, domain))) {
      continue;
    }

    for (let index = nextDomains.length - 1; index >= 0; index -= 1) {
      if (isMessageLimitsDomainCoveredBy(nextDomains[index] ?? '', action.domain)) {
        nextDomains.splice(index, 1);
      }
    }

    if (nextDomains.length >= maxDomains) {
      continue;
    }

    nextDomains.push(action.domain);
    addedDomains.push(action.domain);
  }

  return {
    actions,
    addedDomains,
    nextDomains,
    removedDomains,
  };
}
