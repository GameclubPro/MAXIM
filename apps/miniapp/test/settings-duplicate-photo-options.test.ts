import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  formatDuplicateActionSummary,
  formatDuplicatePhotoCoverageLabel,
  formatDuplicatePhotoModerationHint,
  resolveDuplicatePhotoPolicyForDraft,
} from '../src/pages/settings/settings-duplicate-photo-status';
import { formatDuplicatePhotoMatchPresetHint } from '../src/pages/settings/settings-duplicate-photo-options';
import { buildChatSettingsScreen } from '../src/lib/api/preview-transport-settings';
import { createPreviewState } from '../src/lib/api/preview-transport-state';

const deleteOnlyPolicy = {
  moderationMode: 'DELETE_ONLY' as const,
  actionCeiling: 'DELETE_MESSAGE' as const,
  allowedMatchKinds: ['canonical_sha256' as const],
};
const mutePolicy = {
  moderationMode: 'FULL' as const,
  actionCeiling: 'MUTE' as const,
  allowedMatchKinds: ['canonical_sha256' as const],
};
const disabledSanctions = {
  duplicateWarnEnabled: false,
  duplicateMuteEnabled: false,
  duplicateBanEnabled: false,
};
const muteAndBanSanctions = {
  duplicateWarnEnabled: false,
  duplicateMuteEnabled: true,
  duplicateBanEnabled: true,
};

const duplicatesSectionSource = readFileSync(
  new URL('../src/pages/settings/settings-duplicates-section.tsx', import.meta.url),
  'utf8',
);
const photoControlsSource = readFileSync(
  new URL('../src/pages/settings/settings-duplicate-photo-controls.tsx', import.meta.url),
  'utf8',
);
const settingsPageSource = readFileSync(
  new URL('../src/pages/settings-page.legacy.tsx', import.meta.url),
  'utf8',
);
const settingsSectionToggleSource = readFileSync(
  new URL('../src/components/ui/settings-section-toggle.tsx', import.meta.url),
  'utf8',
);
const duplicateStageStyles = readFileSync(
  new URL('../src/pages/settings/settings-duplicate-stage.css', import.meta.url),
  'utf8',
);
const duplicatePhotoStyles = readFileSync(
  new URL('../src/pages/settings/settings-duplicate-photo.css', import.meta.url),
  'utf8',
);

test('anti-duplicate master toggle preserves configured child actions', () => {
  const masterStart = duplicatesSectionSource.indexOf('>Включить антидубль</span>');
  const nextGroupStart = duplicatesSectionSource.indexOf('>Что проверять</h3>');
  const masterSource = duplicatesSectionSource.slice(masterStart, nextGroupStart);

  assert.ok(masterStart >= 0);
  assert.ok(nextGroupStart > masterStart);
  assert.match(masterSource, /setFieldValue\('antiDuplicateEnabled', event\.target\.checked\)/u);
  assert.doesNotMatch(masterSource, /applyDuplicateFlowConfig/u);
  assert.doesNotMatch(masterSource, /duplicate(BotMessage|Warn|Mute|Ban)Enabled/u);
});

test('anti-duplicate screen keeps the requested task order and effective photo status boundary', () => {
  const contentOrder = ['Что проверять', 'Когда срабатывать', 'Что делать', 'Итог'].map((label) =>
    duplicatesSectionSource.indexOf(`>${label}<`),
  );

  assert.ok(contentOrder.every((position) => position >= 0));
  assert.deepEqual(
    contentOrder,
    [...contentOrder].sort((left, right) => left - right),
  );
  assert.match(
    duplicatesSectionSource,
    /<h3 className="duplicate-settings-group__title">Что проверять<\/h3>/u,
  );
  assert.match(photoControlsSource, /\{enabled \? \(\s*<p className="policy-mode-hint">/u);
  assert.match(duplicatesSectionSource, /title="Антидубль"/u);
  assert.match(duplicatesSectionSource, /Находит повторный текст и изображения/u);
  assert.doesNotMatch(duplicatesSectionSource, /DUPLICATE_DETECTION_HINTS/u);
  assert.equal(
    duplicatesSectionSource.match(/Остальной текст может отличаться\./gu)?.length,
    2,
  );
  assert.match(duplicatesSectionSource, /Только для длинных сообщений\./u);
  assert.match(duplicatesSectionSource, /aria-invalid=\{Boolean\(fieldErrors\.duplicateWarn/u);
  assert.match(settingsSectionToggleSource, /Антидубль: '.*фото'/u);
  assert.match(settingsPageSource, /доп\. действия \$\{duplicateStagesEnabledCount\}\/4/u);
  assert.match(
    settingsPageSource,
    /refetchInterval: expandedSections\.duplicates \? 60_000 : false/u,
  );
  assert.match(
    settingsPageSource,
    /shouldHydrateSettingsDraftFromServer\(\s*draftRef\.current/u,
  );
  assert.match(settingsPageSource, /if \(!shouldHydrate\) \{\s*return;\s*\}/u);
  assert.match(
    settingsPageSource,
    /if \(section === 'duplicates' && !expandedSections\.duplicates\)\s*void settingsScreenQuery\.refetch\(\);/u,
  );
  assert.match(
    settingsPageSource,
    /if \(section === 'duplicates'\) \{\s*setDuplicateWindowInputValue\(''\);\s*\}/u,
  );
  assert.doesNotMatch(duplicateStageStyles, /duplicate-settings-group__title/u);
  assert.match(
    duplicatePhotoStyles,
    /settings-drilldown__panel--duplicates \.duplicate-settings-group__title/u,
  );
});

test('photo duplicate presentation shows rollout only when photo checking is enabled', () => {
  for (const moderationMode of ['OFF', 'OBSERVE', 'DELETE_ONLY', 'FULL'] as const) {
    assert.equal(
      formatDuplicatePhotoCoverageLabel('Похожие', false, {
        moderationMode,
        actionCeiling: 'BAN',
        allowedMatchKinds: [],
      }),
      'Текст: Похожие',
    );
  }

  assert.equal(
    formatDuplicatePhotoCoverageLabel('Похожие', true, {
      ...deleteOnlyPolicy,
      moderationMode: 'OFF',
    }),
    'Текст: Похожие • фото неактивно',
  );
  assert.equal(
    formatDuplicatePhotoCoverageLabel('Похожие', true, {
      ...deleteOnlyPolicy,
      moderationMode: 'OBSERVE',
    }),
    'Текст: Похожие • фото: наблюдение',
  );
  assert.equal(
    formatDuplicatePhotoCoverageLabel('Похожие', true, deleteOnlyPolicy, disabledSanctions),
    'Текст: Похожие • фото: только точные, удаление',
  );
  assert.equal(
    formatDuplicatePhotoCoverageLabel('Похожие', true, mutePolicy, muteAndBanSanctions),
    'Текст: Похожие • фото: только точные, до ограничения',
  );
});

test('photo status follows enabled sanctions as well as the server action ceiling', () => {
  assert.equal(
    formatDuplicatePhotoCoverageLabel('Одинаковый', true, mutePolicy, {
      duplicateWarnEnabled: false,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: true,
    }),
    'Текст: Одинаковый • фото: только точные, удаление',
  );
  assert.equal(
    formatDuplicatePhotoCoverageLabel('Одинаковый', true, mutePolicy, {
      duplicateWarnEnabled: true,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: true,
    }),
    'Текст: Одинаковый • фото: только точные, до предупреждения',
  );
  assert.equal(
    formatDuplicatePhotoCoverageLabel(
      'Одинаковый',
      true,
      { ...mutePolicy, actionCeiling: 'BAN', allowedMatchKinds: ['canonical_sha256', 'pdq'] },
      { duplicateWarnEnabled: false, duplicateMuteEnabled: false, duplicateBanEnabled: true },
    ),
    'Текст: Одинаковый • фото: до блокировки',
  );
});

test('duplicate action summary follows enabled stages and effective photo mode', () => {
  const settings = {
    duplicatePhotoEnabled: true,
    duplicateBotMessageEnabled: true,
    duplicateWarnEnabled: false,
    duplicateMuteEnabled: true,
    duplicateBanEnabled: true,
    duplicateMuteDurationHours: 24,
  };

  assert.equal(
    formatDuplicateActionSummary(settings, 1, deleteOnlyPolicy),
    'Текст удаляется с дубля №2. Бот объясняет первое удаление. Санкции: ограничение на 24 ч с №3; блокировка с №4. Точные дубли фото удаляются с дубля №2. Объяснение удаления включено. Санкции для фото выключены.',
  );
  assert.match(
    formatDuplicateActionSummary(settings, 0, mutePolicy),
    /Санкции для фото: ограничение отправки\./u,
  );
  assert.doesNotMatch(formatDuplicateActionSummary(settings, 0, mutePolicy), /для фото:.*блок/u);
  assert.match(
    formatDuplicateActionSummary(settings, 0, { ...deleteOnlyPolicy, actionCeiling: 'BAN' }),
    /Точные дубли фото удаляются с дубля №1\..*Санкции для фото выключены\./u,
  );
});

test('duplicate action summary keeps deletion visible when optional stages are off', () => {
  assert.equal(
    formatDuplicateActionSummary(
      {
        duplicatePhotoEnabled: false,
        duplicateBotMessageEnabled: false,
        duplicateWarnEnabled: false,
        duplicateMuteEnabled: false,
        duplicateBanEnabled: false,
        duplicateMuteDurationHours: 24,
      },
      0,
      {
        moderationMode: 'OBSERVE',
        actionCeiling: 'DELETE_MESSAGE',
        allowedMatchKinds: [],
      },
    ),
    'Текст удаляется с дубля №1. Дополнительные санкции выключены.',
  );
});

test('photo duplicate rollout hints do not promise unavailable actions', () => {
  assert.match(
    formatDuplicatePhotoModerationHint({ ...deleteOnlyPolicy, moderationMode: 'OFF' }),
    /фото не проверяются/u,
  );
  assert.match(
    formatDuplicatePhotoModerationHint({ ...deleteOnlyPolicy, moderationMode: 'OBSERVE' }),
    /Фото не удаляются/u,
  );
  assert.match(formatDuplicatePhotoModerationHint(deleteOnlyPolicy), /для фото выключены/u);
  assert.match(
    formatDuplicatePhotoModerationHint(mutePolicy, muteAndBanSanctions),
    /ограничение отправки/u,
  );
  assert.doesNotMatch(
    formatDuplicatePhotoModerationHint(mutePolicy, muteAndBanSanctions),
    /блокировка/u,
  );
  assert.match(
    formatDuplicatePhotoModerationHint(mutePolicy, muteAndBanSanctions),
    /Точные дубли фото удаляются/u,
  );
  assert.match(
    formatDuplicatePhotoModerationHint(mutePolicy, muteAndBanSanctions),
    /Изменённые варианты остаются в наблюдении без действий/u,
  );
  assert.match(
    formatDuplicatePhotoModerationHint({
      ...mutePolicy,
      allowedMatchKinds: ['platform_id', 'canonical_sha256'],
    }),
    /Изменённые варианты остаются в наблюдении без действий/u,
  );
  assert.match(
    formatDuplicatePhotoModerationHint({
      ...mutePolicy,
      allowedMatchKinds: ['platform_id'],
    }),
    /Изменённые варианты остаются в наблюдении без действий/u,
  );
});

test('photo match hint does not promise actions for edited images without PDQ', () => {
  assert.match(
    formatDuplicatePhotoMatchPresetHint('MINOR_EDITS', {
      moderationMode: 'OFF',
      actionCeiling: 'BAN',
      allowedMatchKinds: ['pdq'],
    }),
    /проверка фото выключена/u,
  );
  assert.match(
    formatDuplicatePhotoMatchPresetHint('MINOR_EDITS', mutePolicy),
    /Действия применяются только к точным цифровым совпадениям/u,
  );
  assert.match(
    formatDuplicatePhotoMatchPresetHint('MINOR_EDITS', mutePolicy),
    /Изменённые версии остаются в наблюдении/u,
  );
  assert.match(
    formatDuplicatePhotoMatchPresetHint('MINOR_EDITS', {
      ...mutePolicy,
      allowedMatchKinds: ['canonical_sha256', 'pdq'],
    }),
    /обрезка и цветокоррекция/u,
  );
});

test('draft photo preset and scope select the matching server policy', () => {
  const matrix = {
    base: deleteOnlyPolicy,
    advanced: {
      moderationMode: 'OBSERVE' as const,
      actionCeiling: 'BAN' as const,
      allowedMatchKinds: ['canonical_sha256' as const, 'pdq' as const],
    },
  };

  assert.equal(
    resolveDuplicatePhotoPolicyForDraft(matrix, 'OBSERVE', 'SAME_IMAGE', 'SAME_AUTHOR'),
    matrix.base,
  );
  assert.equal(
    resolveDuplicatePhotoPolicyForDraft(matrix, 'DELETE_ONLY', 'MINOR_EDITS', 'SAME_AUTHOR'),
    matrix.advanced,
  );
  assert.equal(
    resolveDuplicatePhotoPolicyForDraft(matrix, 'DELETE_ONLY', 'SAME_IMAGE', 'CHAT'),
    matrix.advanced,
  );
  assert.equal(
    resolveDuplicatePhotoPolicyForDraft(matrix, 'DELETE_ONLY', 'MINOR_EDITS', 'CHAT'),
    matrix.advanced,
  );
  assert.deepEqual(resolveDuplicatePhotoPolicyForDraft(undefined, 'FULL', 'MINOR_EDITS', 'CHAT'), {
    moderationMode: 'FULL',
    actionCeiling: 'BAN',
    allowedMatchKinds: ['canonical_sha256'],
  });
  assert.deepEqual(
    resolveDuplicatePhotoPolicyForDraft(undefined, 'FULL', 'MINOR_EDITS', 'CHAT', {
      duplicatePhotoMatchPreset: 'SAME_IMAGE',
      duplicatePhotoScope: 'SAME_AUTHOR',
    }),
    {
      moderationMode: 'OBSERVE',
      actionCeiling: 'DELETE_MESSAGE',
      allowedMatchKinds: [],
    },
  );
});

test('photo duplicate visual preview exposes deletion and full sanction policies', () => {
  const screen = buildChatSettingsScreen(
    createPreviewState({ clock: { now: () => new Date('2026-01-15T09:00:00.000Z') } }),
    'chat-preview',
  );

  assert.equal(screen.duplicatePhotoModerationMode, 'DELETE_ONLY');
  assert.deepEqual(screen.duplicatePhotoPolicyMatrix, {
    base: deleteOnlyPolicy,
    advanced: {
      moderationMode: 'FULL',
      actionCeiling: 'BAN',
      allowedMatchKinds: ['canonical_sha256', 'pdq'],
    },
  });
});
