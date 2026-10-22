import {
  normalizeStopWordsDomain,
  normalizeStopWordsValue,
  STOP_WORDS_RULES_MAX,
  STOP_WORDS_DOMAINS_MAX,
  stopWordsPolicySchema,
  stopWordsRuleSchema,
  type StopWordsPolicy,
  type StopWordsRule,
} from '@maxim/contracts/settings';
import { createClientRequestId } from './client-request-id';

export type StopWordsInputPreview = {
  policy: StopWordsPolicy;
  added: string[];
  duplicates: string[];
  errors: string[];
};

/** Parse an explicitly authored list without manufacturing a complete chat policy. */
export function prepareStopWordsLists(
  current: Pick<StopWordsPolicy, 'rules' | 'domains'>,
  words: string,
  domains = '',
  createId: () => string = () => createClientRequestId('stop'),
): Omit<StopWordsInputPreview, 'policy'> & { lists: Pick<StopWordsPolicy, 'rules' | 'domains'> } {
  const next = {
    rules: [...current.rules],
    domains: [...current.domains],
  };
  const result: Omit<StopWordsInputPreview, 'policy'> & {
    lists: Pick<StopWordsPolicy, 'rules' | 'domains'>;
  } = { lists: next, added: [], duplicates: [], errors: [] };
  const wordEntries = words
    .split(/[,;\r\n]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const domainEntries = domains
    .split(/[,;\r\n]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (wordEntries.length > STOP_WORDS_RULES_MAX || domainEntries.length > STOP_WORDS_DOMAINS_MAX) {
    return {
      ...result,
      lists: current,
      errors: ['За один раз можно добавить до 999 слов и фраз и до 300 сайтов.'],
    };
  }
  const values = new Set(next.rules.map((rule) => normalizeStopWordsValue(rule.value)));
  for (const raw of wordEntries) {
    const value = normalizeStopWordsValue(raw);
    const parsed = stopWordsRuleSchema.safeParse({
      id: createId(),
      kind: value.includes(' ') ? 'PHRASE' : 'WORD',
      value: raw,
    });
    if (!parsed.success) {
      result.errors.push(`«${raw.slice(0, 80)}»: ${parsed.error.issues[0]?.message}`);
      continue;
    }
    if (values.has(value)) {
      result.duplicates.push(value);
      continue;
    }
    values.add(value);
    next.rules.push(parsed.data);
    result.added.push(parsed.data.value);
  }
  for (const raw of domainEntries) {
    const domain = normalizeStopWordsDomain(raw);
    if (!domain) {
      result.errors.push(`«${raw.slice(0, 80)}»: некорректный домен.`);
      continue;
    }
    if (next.domains.includes(domain)) {
      result.duplicates.push(domain);
      continue;
    }
    // Keep explicit child rules. Removing their parent later must not silently remove protection.
    next.domains.push(domain);
    result.added.push(domain);
  }
  const checked = stopWordsPolicySchema.safeParse({ rules: next.rules, domains: next.domains });
  if (!checked.success) result.errors.push(...checked.error.issues.map((issue) => issue.message));
  if (result.errors.length) result.lists = current;
  result.errors = result.errors.slice(0, 20);
  return result;
}

export function prepareStopWordsInput(
  policy: StopWordsPolicy,
  words: string,
  domains = '',
  createId: () => string = () => createClientRequestId('stop'),
): StopWordsInputPreview {
  const parsed = prepareStopWordsLists(policy, words, domains, createId);
  return {
    policy: parsed.errors.length ? policy : { ...policy, ...parsed.lists },
    added: parsed.added,
    duplicates: parsed.duplicates,
    errors: parsed.errors,
  };
}

export function replaceStopWordsRule(
  policy: StopWordsPolicy,
  rule: StopWordsRule,
): StopWordsPolicy {
  const parsed = stopWordsRuleSchema.parse(rule);
  if (
    policy.rules.some(
      (item) =>
        item.id !== parsed.id &&
        normalizeStopWordsValue(item.value) === normalizeStopWordsValue(parsed.value),
    )
  )
    throw new Error('Duplicate stop-list rule');
  return { ...policy, rules: policy.rules.map((item) => (item.id === parsed.id ? parsed : item)) };
}
