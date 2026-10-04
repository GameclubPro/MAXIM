import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  findSettingMatches,
  buildFieldAliases,
} from '../moderation/private-control-settings-renderer';
import {
  SECTION_FIELDS,
  SECTION_LABELS,
  SECTION_ORDER,
} from '../moderation/private-control-settings-schema';
import { SEARCH_RESULT_LIMIT } from '../moderation/private-control.constants';

// Reference algorithm before static indexing; this benchmark never calls a runtime service.
function previousSearch(query: string): ReturnType<typeof findSettingMatches> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const result: ReturnType<typeof findSettingMatches> = [];
  for (const section of SECTION_ORDER) {
    for (const field of SECTION_FIELDS[section]) {
      if (
        !buildFieldAliases(section, String(field.key), field.label).some((alias) =>
          alias.includes(normalized),
        )
      )
        continue;
      result.push({
        section,
        key: field.key,
        label: field.label,
        sectionLabel: SECTION_LABELS[section],
      });
    }
  }
  return result.slice(0, SEARCH_RESULT_LIMIT);
}

const queries = [
  '',
  '  МУТ  ',
  'timezone',
  'Ссылка',
  'кнопка',
  'приветствие',
  'нет-совпадений',
  ...SECTION_ORDER.flatMap((section) =>
    SECTION_FIELDS[section].flatMap((field) => [
      field.label,
      String(field.key),
      field.label.slice(0, 3),
    ]),
  ),
  'not-a-setting',
  'МУТ',
  '  ссылка  ',
  '',
  '  ',
  '🙂',
];
for (const query of queries) assert.deepEqual(findSettingMatches(query), previousSearch(query));
const first = findSettingMatches('мут');
const expected = structuredClone(first);
first[0]!.label = 'caller override';
first.length = 0;
assert.deepEqual(findSettingMatches('мут'), expected);

let resultCount = 0;
const measure = (search: typeof findSettingMatches, repeats: number) => {
  const started = performance.now();
  for (let i = 0; i < repeats; i++)
    for (const query of queries) resultCount += search(query).length;
  return performance.now() - started;
};
measure(previousSearch, 5);
measure(findSettingMatches, 5);
const before: number[] = [],
  after: number[] = [];
for (let sample = 0; sample < 9; sample++) {
  if (sample % 2) {
    after.push(measure(findSettingMatches, 20));
    before.push(measure(previousSearch, 20));
  } else {
    before.push(measure(previousSearch, 20));
    after.push(measure(findSettingMatches, 20));
  }
}
const stats = (samplesMs: number[]) => {
  const values = [...samplesMs].sort((a, b) => a - b);
  return {
    medianMs: values[Math.floor(values.length / 2)]!,
    minMs: values[0],
    maxMs: values.at(-1),
    samplesMs,
  };
};
const previous = stats(before),
  current = stats(after);
console.log(
  JSON.stringify(
    {
      node: process.version,
      queries: queries.length,
      iterationsPerSample: 20 * queries.length,
      warmupPasses: 5,
      before: previous,
      after: current,
      speedup: previous.medianMs / current.medianMs,
      catalogFields: SECTION_ORDER.flatMap((section) => SECTION_FIELDS[section]).length,
      resultCount,
    },
    null,
    2,
  ),
);
