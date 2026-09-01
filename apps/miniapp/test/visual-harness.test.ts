import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  isLocalMiniappBaseUrl,
  waitForMiniappUrl,
} from '../../../scripts/miniapp-local-server.mjs';
import { applyNativeVisualMode } from '../../../scripts/miniapp-native-visual-mode.mjs';
import {
  DEFAULT_MINIAPP_VISUAL_NOW,
  LOCAL_MINIAPP_BASE_URL,
  PRODUCTION_MINIAPP_BASE_URL,
  resolveMiniappScreenshotBaseUrl,
  resolveMiniappVisualAuditBaseUrls,
  resolveMiniappVisualNow,
  resolveScenarioRuntime,
} from '../../../scripts/miniapp-visual-config.mjs';
import {
  findMissingColdRuntimeRoutes,
  matchesSourceGlob,
  MINIAPP_RUNTIME_ROUTES,
  MINIAPP_VISUAL_PRESETS,
  MINIAPP_VISUAL_SCENARIOS,
  selectMiniappVisualScenarios,
} from '../../../scripts/miniapp-visual-scenarios.mjs';

test('visual commands use the local working tree unless production is explicit', () => {
  assert.equal(resolveMiniappScreenshotBaseUrl({}), LOCAL_MINIAPP_BASE_URL);
  assert.equal(
    resolveMiniappScreenshotBaseUrl({ MINIAPP_SCREENSHOT_MODE: 'production' }),
    PRODUCTION_MINIAPP_BASE_URL,
  );
  assert.equal(
    resolveMiniappScreenshotBaseUrl({
      MINIAPP_SCREENSHOT_MODE: 'production',
      MINIAPP_SCREENSHOT_BASE_URL: 'http://127.0.0.1:4173/app/',
    }),
    'http://127.0.0.1:4173/app/',
  );
  assert.deepEqual(resolveMiniappVisualAuditBaseUrls({}), [LOCAL_MINIAPP_BASE_URL]);
  assert.deepEqual(resolveMiniappVisualAuditBaseUrls({ MINIAPP_VISUAL_AUDIT_MODE: 'prod' }), [
    PRODUCTION_MINIAPP_BASE_URL,
  ]);
  assert.throws(
    () => resolveMiniappScreenshotBaseUrl({ MINIAPP_SCREENSHOT_MODE: 'staging' }),
    /local, production/u,
  );
});

test('visual clock and per-scenario runtime policy are deterministic', () => {
  assert.equal(resolveMiniappVisualNow({}).toISOString(), DEFAULT_MINIAPP_VISUAL_NOW);
  assert.equal(
    resolveMiniappVisualNow({ MINIAPP_SCREENSHOT_NOW: '2026-07-19T12:30:00+03:00' }).toISOString(),
    '2026-07-19T09:30:00.000Z',
  );
  assert.throws(
    () => resolveMiniappVisualNow({ MINIAPP_SCREENSHOT_NOW: 'not-a-date' }),
    /valid ISO date-time/u,
  );
  assert.deepEqual(resolveScenarioRuntime({ preview: false, maxBridge: false }, true), {
    previewEnabled: false,
    bridgeEnabled: false,
  });
  assert.deepEqual(resolveScenarioRuntime({}, true), {
    previewEnabled: true,
    bridgeEnabled: true,
  });
  assert.equal(isLocalMiniappBaseUrl(LOCAL_MINIAPP_BASE_URL), true);
  assert.equal(isLocalMiniappBaseUrl(PRODUCTION_MINIAPP_BASE_URL), false);
});

test('local server startup reports an early child-process exit immediately', async () => {
  await assert.rejects(
    waitForMiniappUrl('http://127.0.0.1:1/app/', 30_000, {
      childProcess: { exitCode: 1, signalCode: null },
    }),
    /exit code 1/u,
  );
});

test('preview runtime owns only its frame CSS and leaves route CSS lazy', () => {
  const source = readFileSync(new URL('../src/preview-runtime.ts', import.meta.url), 'utf8');
  const cssImports = Array.from(
    source.matchAll(/import ['"]([^'"]+\.css)['"]/gu),
    (match) => match[1],
  );

  assert.deepEqual(cssImports, ['./styles/design-preview.css']);
});

test('visual metadata covers every runtime route with a cold scenario', () => {
  assert.deepEqual(findMissingColdRuntimeRoutes(), []);
  assert.equal(
    new Set(MINIAPP_VISUAL_SCENARIOS.map((scenario) => scenario.name)).size,
    MINIAPP_VISUAL_SCENARIOS.length,
  );
  assert.ok(MINIAPP_RUNTIME_ROUTES.length >= 13);

  for (const scenario of MINIAPP_VISUAL_SCENARIOS) {
    assert.ok(scenario.routeId);
    assert.ok(scenario.features.length > 0);
    assert.ok(scenario.sourceGlobs.length > 0);
    assert.ok(scenario.tags.some((tag) => tag.startsWith('route:')));
  }
});

test('photo duplicate controls have a dedicated visual scenario', () => {
  const scenario = MINIAPP_VISUAL_SCENARIOS.find(
    (candidate) => candidate.name === 'chat-settings-duplicates-photos',
  );

  assert.equal(scenario?.routeId, 'chat-settings');
  assert.ok(scenario?.features.includes('settings'));
  assert.ok(scenario?.features.includes('duplicates'));
});

test('chat poll creation, saved draft, and publication have dedicated visual scenarios', () => {
  const scenarios = new Map(MINIAPP_VISUAL_SCENARIOS.map((scenario) => [scenario.name, scenario]));

  for (const name of [
    'chat-settings-poll-editor',
    'chat-settings-poll-draft',
    'chat-settings-poll-published',
  ]) {
    const scenario = scenarios.get(name);
    assert.equal(scenario?.routeId, 'chat-settings');
    assert.ok(scenario?.features.includes('settings'));
    assert.ok(scenario?.features.includes('polls'));
  }
});

test('settings auth and access errors have dedicated visual scenarios', () => {
  const scenarios = new Map(MINIAPP_VISUAL_SCENARIOS.map((scenario) => [scenario.name, scenario]));

  for (const entityType of ['chat', 'channel'] as const) {
    for (const errorKind of ['auth-expired', 'access-denied'] as const) {
      const scenario = scenarios.get(`${entityType}-settings-${errorKind}`);

      assert.equal(scenario?.routeId, `${entityType}-settings`);
      assert.deepEqual(scenario?.searchParams, { settingsError: errorKind });
      assert.equal(scenario?.readySelector, '.status-state');
      assert.ok(scenario?.features.includes('settings'));
    }
  }
});

test('publisher profile has dedicated publication and chat comment scenarios', () => {
  const scenarios = new Map(MINIAPP_VISUAL_SCENARIOS.map((scenario) => [scenario.name, scenario]));

  assert.deepEqual(scenarios.get('publications-publisher')?.searchParams, {
    profile: 'publisher',
  });
  assert.deepEqual(scenarios.get('publications-publisher-create')?.searchParams, {
    profile: 'publisher',
    create: '1',
    entityType: 'channel',
    entityId: 'preview-channel',
  });
  assert.deepEqual(scenarios.get('publications-publisher-schedules')?.searchParams, {
    profile: 'publisher',
    view: 'schedules',
  });
  assert.deepEqual(scenarios.get('publications-publisher-history')?.searchParams, {
    profile: 'publisher',
    view: 'history',
  });
  assert.deepEqual(scenarios.get('chat-dialog-comments-publisher')?.searchParams, {
    token: 'preview-comments-token-0001',
    profile: 'publisher',
  });
  assert.ok(scenarios.get('publications-publisher')?.features.includes('publisher'));
  assert.ok(scenarios.get('publications-publisher-create')?.features.includes('publisher'));
  assert.ok(scenarios.get('chat-dialog-comments-publisher')?.features.includes('publisher'));
  assert.deepEqual(scenarios.get('publications-publisher-compose')?.searchParams, {
    profile: 'publisher',
    compose: '1',
  });
  assert.deepEqual(scenarios.get('publications-publisher-compose-long')?.searchParams, {
    profile: 'publisher',
    compose: '1',
  });
  assert.deepEqual(scenarios.get('publications-publisher-compose-media-first')?.searchParams, {
    profile: 'publisher',
    compose: '1',
  });
  assert.deepEqual(scenarios.get('publications-publisher-empty')?.searchParams, {
    profile: 'publisher',
    publisherState: 'empty',
  });
  assert.deepEqual(scenarios.get('publications-publisher-error')?.searchParams, {
    profile: 'publisher',
    publisherState: 'error',
  });
  assert.deepEqual(scenarios.get('publications-publisher-large')?.searchParams, {
    profile: 'publisher',
    publisherState: 'large',
  });
  assert.deepEqual(scenarios.get('publications-publisher-compose-large')?.searchParams, {
    profile: 'publisher',
    publisherState: 'large',
    compose: '1',
  });
  assert.deepEqual(scenarios.get('publications-publisher-compose-missing-target')?.searchParams, {
    profile: 'publisher',
    compose: '1',
    entityType: 'chat',
    entityId: 'preview-missing-chat',
  });
  assert.deepEqual(scenarios.get('publications-publisher-compose-unready-target')?.searchParams, {
    profile: 'publisher',
    compose: '1',
    entityType: 'chat',
    entityId: 'preview-chat-2',
  });
  assert.ok(scenarios.get('publications-publisher-compose')?.features.includes('publisher'));
  assert.deepEqual(scenarios.get('publisher-entities')?.searchParams, {
    profile: 'publisher',
  });
  assert.deepEqual(scenarios.get('publisher-entities-channels')?.searchParams, {
    profile: 'publisher',
    view: 'channel',
  });
  assert.deepEqual(scenarios.get('publisher-entities-channel-only')?.searchParams, {
    profile: 'publisher',
    publisherState: 'channel-only',
  });
  assert.deepEqual(scenarios.get('publisher-entities-empty')?.searchParams, {
    profile: 'publisher',
    publisherState: 'empty',
  });
  assert.deepEqual(scenarios.get('publisher-entities-error')?.searchParams, {
    profile: 'publisher',
    publisherState: 'error',
  });
  assert.deepEqual(scenarios.get('publisher-entities-large')?.searchParams, {
    profile: 'publisher',
    publisherState: 'large',
  });
  assert.deepEqual(scenarios.get('publisher-entity-modules-blocked')?.searchParams, {
    profile: 'publisher',
  });
  assert.equal(
    scenarios.get('publisher-entity-modules-blocked')?.path,
    '/publisher/chat/preview-chat-2',
  );
  assert.deepEqual(scenarios.get('publisher-channel-suggestions-open-draft')?.searchParams, {
    profile: 'publisher',
    publisherSuggestions: 'large',
  });
  assert.deepEqual(scenarios.get('publisher-channel-suggestions-cancel-confirm')?.searchParams, {
    profile: 'publisher',
    publisherSuggestions: 'large',
  });
  assert.deepEqual(
    scenarios.get('publisher-channel-suggestions-image-only-cancel-confirm')?.searchParams,
    {
      profile: 'publisher',
      publisherSuggestions: 'large',
    },
  );
  assert.deepEqual(
    scenarios.get('publisher-channel-suggestions-image-only-open-draft')?.searchParams,
    {
      profile: 'publisher',
      publisherSuggestions: 'large',
      channelPostSignature: 'button',
    },
  );
  assert.deepEqual(scenarios.get('publisher-channel-suggestions-history')?.searchParams, {
    profile: 'publisher',
    publisherSuggestions: 'large',
  });
  assert.deepEqual(scenarios.get('chat-settings-publisher-policy-setup')?.searchParams, {
    publisherPolicyState: 'setup',
  });
  assert.deepEqual(scenarios.get('chat-settings-publisher-policy-error')?.searchParams, {
    publisherPolicyState: 'error',
  });
  assert.equal(scenarios.get('channel-settings-publisher-policy')?.routeId, 'channel-settings');
  assert.ok(scenarios.get('channel-settings-publisher-policy')?.features.includes('publisher'));
  assert.deepEqual(scenarios.get('channel-settings-publisher-policy-permission')?.searchParams, {
    publisherPolicyState: 'permission',
  });
});

test('image-only publisher suggestion has fail-closed visual guards', () => {
  const scenarioName = 'publisher-channel-suggestions-image-only-cancel-confirm';
  const scenario = MINIAPP_VISUAL_SCENARIOS.find((candidate) => candidate.name === scenarioName);
  assert.equal(scenario?.routeId, 'publisher-entity-modules');
  assert.equal(scenario?.path, '/publisher/channel/preview-channel');
  assert.ok(scenario?.features.includes('publisher'));

  const captureSource = readFileSync(
    new URL('../../../scripts/capture-miniapp-preview.mjs', import.meta.url),
    'utf8',
  );
  const behaviorStart = captureSource.indexOf(`name: '${scenarioName}'`);
  const behaviorEnd = captureSource.indexOf(
    "name: 'publisher-channel-suggestions-image-only-open-draft'",
    behaviorStart,
  );
  const behaviorSource = captureSource.slice(behaviorStart, behaviorEnd);
  assert.ok(behaviorStart >= 0 && behaviorEnd > behaviorStart);
  assert.match(behaviorSource, /Автор 2/u);
  assert.match(behaviorSource, /1 фото/u);
  assert.match(behaviorSource, /publisher-suggestion-row__text/u);
  assert.match(behaviorSource, /Предложение без текста/u);
  assert.match(behaviorSource, /Отклонить предложение\?/u);

  const auditSource = readFileSync(
    new URL('../../../scripts/audit-miniapp-visual.mjs', import.meta.url),
    'utf8',
  );
  assert.match(auditSource, new RegExp(`'${scenarioName}'`, 'u'));
});

test('image-only publisher suggestion opens a draft with retained media', () => {
  const scenarioName = 'publisher-channel-suggestions-image-only-open-draft';
  const scenario = MINIAPP_VISUAL_SCENARIOS.find((candidate) => candidate.name === scenarioName);
  assert.equal(scenario?.routeId, 'publisher-entity-modules');
  assert.equal(scenario?.path, '/publisher/channel/preview-channel');

  const captureSource = readFileSync(
    new URL('../../../scripts/capture-miniapp-preview.mjs', import.meta.url),
    'utf8',
  );
  const behaviorStart = captureSource.indexOf(`name: '${scenarioName}'`);
  const behaviorEnd = captureSource.indexOf(
    "name: 'publisher-channel-suggestions-history'",
    behaviorStart,
  );
  const behaviorSource = captureSource.slice(behaviorStart, behaviorEnd);
  assert.ok(behaviorStart >= 0 && behaviorEnd > behaviorStart);
  assert.match(behaviorSource, /Автор 2/u);
  assert.match(behaviorSource, /Открыть в редакторе/u);
  assert.match(behaviorSource, /publication-retained-media/u);
  assert.match(behaviorSource, /suggestion-photo-1\.png/u);
  assert.match(behaviorSource, /💬 Комментарии/u);
  assert.match(behaviorSource, /✍️ Предложить объявление/u);
  assert.match(behaviorSource, /📞 Заказать рекламу/u);
});

test('public suggestion scenarios keep Major rules and reject Publisher synthetic copy', () => {
  const captureSource = readFileSync(
    new URL('../../../scripts/capture-miniapp-preview.mjs', import.meta.url),
    'utf8',
  );
  const behaviorStart = captureSource.indexOf("name: 'channel-dialog-suggest-publisher'");
  const behaviorEnd = captureSource.indexOf("name: 'publisher-entity-modules-cold'", behaviorStart);
  const behaviorSource = captureSource.slice(behaviorStart, behaviorEnd);
  const majorBehaviorStart = captureSource.indexOf("name: 'channel-dialog-suggest'");
  const majorBehaviorSource = captureSource.slice(majorBehaviorStart, behaviorStart);

  assert.ok(majorBehaviorStart >= 0 && behaviorStart > majorBehaviorStart);
  assert.match(majorBehaviorSource, /Требования/u);
  assert.match(majorBehaviorSource, /Только события нашего города/u);
  assert.ok(behaviorStart >= 0 && behaviorEnd > behaviorStart);
  assert.match(behaviorSource, /Текст объявления/u);
  assert.match(behaviorSource, /Требования/u);
  assert.match(behaviorSource, /Фото · market-evening\.webp/u);
  assert.match(behaviorSource, /channel-suggest-card__status-detail/u);
  assert.match(behaviorSource, /Предложение отправлено/u);
});

test('publisher publication buttons cover direct empty, filled, error, and keyboard states', () => {
  const scenarioNames = [
    'publications-publisher-buttons-empty',
    'publications-publisher-buttons-filled',
    'publications-publisher-buttons-error',
    'publications-publisher-buttons-keyboard',
  ];
  const scenarios = new Map(MINIAPP_VISUAL_SCENARIOS.map((scenario) => [scenario.name, scenario]));

  for (const name of scenarioNames) {
    const scenario = scenarios.get(name);
    assert.equal(scenario?.routeId, 'publications');
    assert.deepEqual(scenario?.searchParams, { profile: 'publisher', compose: '1' });
    assert.ok(scenario?.features.includes('publisher'));
    assert.ok(scenario?.features.includes('broadcast'));
  }
  assert.equal(scenarios.get('publications-publisher-buttons-keyboard')?.keyboard, true);

  const selection = selectMiniappVisualScenarios({
    changedFiles: ['apps/miniapp/src/features/publications/publication-buttons-sheet.tsx'],
  });
  const selectedNames = selection.scenarios.map((scenario) => scenario.name);
  for (const name of scenarioNames) {
    assert.ok(selectedNames.includes(name), name);
  }

  const captureSource = readFileSync(
    new URL('../../../scripts/capture-miniapp-preview.mjs', import.meta.url),
    'utf8',
  );
  assert.match(captureSource, /\.publication-buttons-sheet/u);
  assert.match(captureSource, /Publisher buttons sheet restored the obsolete enable toggle/u);
  assert.match(captureSource, /getByLabel\('Название'/u);
  assert.match(captureSource, /getByLabel\('Ссылка'/u);
  assert.match(captureSource, /name: 'Ещё'/u);
  assert.match(captureSource, /name: 'Готово'/u);
  assert.match(captureSource, /locator\('\.publication-buttons-sheet__field'\)/u);
  assert.doesNotMatch(captureSource, /locator\('label\.field'\)/u);
  assert.match(captureSource, /page\.keyboard\.press\('Escape'\)/u);
  assert.match(captureSource, /\.publication-buttons-sheet__backdrop/u);
  assert.match(captureSource, /name: 'Убрать кнопку 1'/u);
  assert.match(captureSource, /aria-invalid/u);
  assert.match(captureSource, /aria-describedby/u);
  assert.match(captureSource, /exercisePublisherButtonsKeyboardFlow/u);
  assert.match(captureSource, /assertPublisherButtonsKeyboardFinalLayout/u);
});

test('publisher access-required publication has a fail-closed visual scenario', () => {
  const scenario = MINIAPP_VISUAL_SCENARIOS.find(
    (candidate) => candidate.name === 'publications-publisher-access-required',
  );
  assert.equal(scenario?.routeId, 'publications');
  assert.deepEqual(scenario?.searchParams, { profile: 'publisher' });
  assert.ok(scenario?.features.includes('publisher'));
  assert.ok(scenario?.features.includes('publications'));

  const selection = selectMiniappVisualScenarios({
    changedFiles: ['apps/miniapp/src/features/publications/publication-details-sheet.tsx'],
  });
  assert.ok(
    selection.scenarios.some(
      (candidate) => candidate.name === 'publications-publisher-access-required',
    ),
  );

  const captureSource = readFileSync(
    new URL('../../../scripts/capture-miniapp-preview.mjs', import.meta.url),
    'utf8',
  );
  const behaviorStart = captureSource.indexOf("name: 'publications-publisher-access-required'");
  const behaviorEnd = captureSource.indexOf("name: 'publications-actions'", behaviorStart);
  const behaviorSource = captureSource.slice(behaviorStart, behaviorEnd);
  assert.ok(behaviorStart >= 0 && behaviorEnd > behaviorStart);
  assert.match(behaviorSource, /Ожидает доступа/u);
  assert.match(behaviorSource, /Нужен доступ/u);
  assert.match(behaviorSource, /Проверить подключения/u);
  assert.match(behaviorSource, /includes\('PUBLISHER_'\)/u);
  assert.match(behaviorSource, /includes\('Отправлено 0\/0'\)/u);
});

test('publisher imported draft exposes omitted buttons recovery in the visual harness', () => {
  const scenario = MINIAPP_VISUAL_SCENARIOS.find(
    (candidate) => candidate.name === 'publications-publisher-import-buttons-omitted',
  );
  assert.equal(scenario?.routeId, 'publications');
  assert.deepEqual(scenario?.searchParams, {
    profile: 'publisher',
    publisherImport: 'ready',
    import: 'preview_import_token_123456',
  });
  assert.ok(scenario?.features.includes('publisher'));
  assert.ok(scenario?.features.includes('broadcast'));

  const captureSource = readFileSync(
    new URL('../../../scripts/capture-miniapp-preview.mjs', import.meta.url),
    'utf8',
  );
  assert.match(captureSource, /\.publication-import-buttons-notice/u);
  assert.match(captureSource, /Кнопки не перенесены/u);
  assert.match(captureSource, /name: 'Добавить'/u);
});

test('publisher auto replies cover cold list, create sheet, editor bottom, and keyboard states', () => {
  const scenarioNames = [
    'publisher-auto-replies-cold',
    'publisher-auto-replies-create-sheet',
    'publisher-auto-replies-editor',
    'publisher-auto-replies-editor-buttons',
    'publisher-auto-replies-editor-bottom',
    'publisher-auto-replies-editor-keyboard',
  ];
  const scenarios = new Map(MINIAPP_VISUAL_SCENARIOS.map((scenario) => [scenario.name, scenario]));
  const route = MINIAPP_RUNTIME_ROUTES.find(
    (candidate) => candidate.id === 'publisher-auto-replies',
  );

  assert.deepEqual(route, {
    id: 'publisher-auto-replies',
    pattern: '/publisher/chat/:entityId/auto-replies',
    manifestEntry: 'src/pages/publisher-auto-replies-page.tsx',
    coldScenario: 'publisher-auto-replies-cold',
  });
  for (const name of scenarioNames) {
    const scenario = scenarios.get(name);
    assert.equal(scenario?.routeId, 'publisher-auto-replies');
    assert.equal(scenario?.path, '/publisher/chat/preview-chat/auto-replies');
    assert.deepEqual(scenario?.searchParams, { profile: 'publisher' });
    assert.ok(scenario?.features.includes('publisher'));
    assert.ok(scenario?.features.includes('auto-replies'));
  }
  assert.equal(scenarios.get('publisher-auto-replies-cold')?.cold, true);
  assert.equal(scenarios.get('publisher-auto-replies-editor-keyboard')?.keyboard, true);
  assert.equal(scenarios.get('publisher-auto-replies-editor-bottom')?.keyboard, false);
  assert.equal(scenarios.get('publisher-auto-replies-editor')?.keyboard, undefined);
  assert.equal(scenarios.get('publisher-auto-replies-editor-buttons')?.keyboard, undefined);

  const selection = selectMiniappVisualScenarios({
    changedFiles: ['apps/miniapp/src/pages/publisher-auto-replies-page.tsx'],
  });
  assert.deepEqual(
    selection.scenarios.map((scenario) => scenario.name),
    scenarioNames,
  );

  const captureSource = readFileSync(
    new URL('../../../scripts/capture-miniapp-preview.mjs', import.meta.url),
    'utf8',
  );
  const bottomStart = captureSource.indexOf("name: 'publisher-auto-replies-editor-bottom'");
  const bottomEnd = captureSource.indexOf(
    'name: PUBLISHER_AUTO_REPLY_KEYBOARD_SCENARIO',
    bottomStart,
  );
  const bottomBehavior = captureSource.slice(bottomStart, bottomEnd);
  assert.ok(bottomStart >= 0 && bottomEnd > bottomStart);
  assert.match(bottomBehavior, /\.publisher-auto-reply-editor__section/u);
  assert.match(bottomBehavior, /scrollIntoView/u);
  assert.match(bottomBehavior, /assertLocatorWithinViewport/u);
  assert.match(captureSource, /openPublisherAutoReplyButtonsSheet/u);
  assert.match(captureSource, /name: 'Добавить кнопки'/u);
  assert.match(captureSource, /fill\('Открыть каталог'\)/u);
});

test('large publisher catalog scenario reaches the final row through real scroll input', () => {
  const captureSource = readFileSync(
    new URL('../../../scripts/capture-miniapp-preview.mjs', import.meta.url),
    'utf8',
  );
  const scenarioStart = captureSource.indexOf("name: 'publisher-entities-large'");
  const scenarioEnd = captureSource.indexOf("name: 'publications'", scenarioStart);
  const scenarioSource = captureSource.slice(scenarioStart, scenarioEnd);

  assert.ok(scenarioStart >= 0 && scenarioEnd > scenarioStart);
  assert.match(scenarioSource, /scrollPaginatedListToStatus\(page/u);
  assert.doesNotMatch(scenarioSource, /scrollIntoViewIfNeeded|\.scrollTop\s*=/u);
  assert.match(scenarioSource, /document\.elementFromPoint/u);
  assert.match(scenarioSource, /aria-posinset="200"/u);
  assert.match(scenarioSource, /rowRect\.bottom <= Math\.min\(listRect\.bottom, navRect\.top\)/u);
  assert.match(scenarioSource, /'30 из 200'/u);
  assert.match(scenarioSource, /'200 получателей'/u);
});

test('large publisher recipient picker reaches every target through real scroll input', () => {
  const captureSource = readFileSync(
    new URL('../../../scripts/capture-miniapp-preview.mjs', import.meta.url),
    'utf8',
  );
  const scenarioStart = captureSource.indexOf("name: 'publications-publisher-compose-large'");
  const scenarioEnd = captureSource.indexOf(
    "name: 'publications-publisher-compose-selected'",
    scenarioStart,
  );
  const scenarioSource = captureSource.slice(scenarioStart, scenarioEnd);

  assert.ok(scenarioStart >= 0 && scenarioEnd > scenarioStart);
  assert.match(scenarioSource, /scrollPaginatedListToStatus\(page/u);
  assert.doesNotMatch(scenarioSource, /scrollIntoViewIfNeeded|\.scrollTop\s*=/u);
  assert.match(scenarioSource, /data-target-position="200"/u);
  assert.match(scenarioSource, /document\.elementFromPoint/u);
  assert.match(scenarioSource, /'Показано 30 из 200'/u);
  assert.match(scenarioSource, /'Показано 200 из 200'/u);
  assert.match(
    captureSource,
    /async function scrollPaginatedListToStatus[\s\S]*?Date\.now\(\) \+ timeoutMs[\s\S]*?page\.mouse\.wheel\(0, 1_200\)[\s\S]*?waitForFunction/u,
  );
});

test('Publik entry route and publisher source files select workspace visual scenarios', () => {
  const publik = MINIAPP_VISUAL_SCENARIOS.find((scenario) => scenario.name === 'publik');
  assert.equal(publik?.path, '/publik');
  assert.equal(publik?.readySelector, '.publisher-entities-page');
  assert.deepEqual(publik?.searchParams, { profile: 'publisher' });
  assert.ok(publik?.features.includes('publisher'));

  for (const changedFile of [
    'apps/miniapp/src/components/publisher-policy-card.tsx',
    'apps/miniapp/src/features/publications/publication-hub-header.css',
    'apps/miniapp/src/features/publications/publication-target-picker.css',
    'apps/miniapp/src/pages/publisher-entities-page.tsx',
    'apps/miniapp/src/pages/publisher-suggestions-inbox.tsx',
    'apps/miniapp/src/lib/publisher-readiness.ts',
    'apps/miniapp/src/lib/publisher-readiness-label.ts',
    'packages/contracts/src/publisher.ts',
  ]) {
    const selectedNames = selectMiniappVisualScenarios({
      changedFiles: [changedFile],
    }).scenarios.map((scenario) => scenario.name);
    assert.ok(selectedNames.includes('publications-publisher'), changedFile);
    assert.ok(selectedNames.includes('publications-publisher-compose'), changedFile);
    assert.ok(selectedNames.includes('publisher-entities'), changedFile);
  }
});

test('default keyboard audit covers the Publik composer', () => {
  const auditSource = readFileSync(
    new URL('../../../scripts/audit-miniapp-visual.mjs', import.meta.url),
    'utf8',
  );

  assert.match(auditSource, /home,chat-settings,publications-publisher-compose/u);
  assert.match(auditSource, /\['android', 'iphone', 'iphone-se'\]/u);
});

test('keyboard capture reduces geometry and exercises the Publik focus flow', () => {
  const captureSource = readFileSync(
    new URL('../../../scripts/capture-miniapp-preview.mjs', import.meta.url),
    'utf8',
  );

  assert.match(captureSource, /await page\.setViewportSize/u);
  assert.match(captureSource, /viewport\.height > viewport\.width \? viewport\.width \+ 1 : 0/u);
  assert.match(captureSource, /cannot preserve viewport orientation while simulating a keyboard/u);
  assert.match(captureSource, /visualKeyboardOriginalHeight/u);
  assert.match(captureSource, /Publisher recipient search after reopening/u);
  assert.match(captureSource, /Publisher rich-text editor/u);
  assert.match(captureSource, /Publisher button URL after focus handoff/u);
  assert.match(captureSource, /Publisher button name after keyboard reopening/u);
  assert.match(captureSource, /Publisher button URL after keyboard reopening/u);
  assert.match(captureSource, /activeMatchesPublisherEditor/u);
  assert.match(
    captureSource,
    /const cycles = keyboardProfile\?\.flow === 'publisher-composer' \? 3 : 1/u,
  );
  assert.match(captureSource, /assertPublisherEditorFullBleed/u);
  assert.match(captureSource, /assertPublisherComposerActionInFlow/u);
  assert.match(
    captureSource,
    /forceKeyboardFlag: keyboardProfile\?\.flow === 'publisher-auto-reply-editor'/u,
  );
  assert.match(captureSource, /Publisher primary publish action does not contain its label/u);
  assert.match(captureSource, /publisher-auto-replies-editor-keyboard/u);
  assert.match(captureSource, /exercisePublisherAutoReplyEditorKeyboardFlow/u);
  assert.match(captureSource, /shouldSimulateKeyboardScenario/u);
  assert.match(captureSource, /Auto-reply text editor/u);
  assert.match(captureSource, /Текст автоответа/u);
  assert.equal(captureSource.match(/await done\.click\(\)/gu)?.length, 2);
  assert.doesNotMatch(captureSource, /root\.style\.setProperty\('--app-keyboard-overlap'/u);
  assert.doesNotMatch(captureSource, /if \(!\(nav instanceof HTMLElement\)\) \{\s*return null;/u);
  assert.ok(
    captureSource.indexOf('if (scenario.beforeShot)') <
      captureSource.indexOf(
        'const keyboardGeometry = await simulateKeyboardViewport(page, scenario)',
      ),
  );
});

test('smoke preset is short, local-device focused, and includes navigation order', () => {
  const smoke = MINIAPP_VISUAL_PRESETS.smoke;
  assert.ok(smoke.scenarioNames.length >= 8 && smoke.scenarioNames.length <= 13);
  assert.equal(smoke.device, 'iphone');
  assert.equal(smoke.target, 'native');
  assert.deepEqual(smoke.checks, {
    layout: true,
    contrast: true,
    accessibility: true,
  });
  assert.ok(smoke.scenarioNames.includes('navigation-home-settings-home'));

  const selection = selectMiniappVisualScenarios({ preset: 'smoke' });
  assert.equal(selection.reason, 'preset:smoke');
  assert.deepEqual(
    selection.scenarios.map((scenario) => scenario.name),
    smoke.scenarioNames,
  );
});

test('changed-file selection uses route and feature source globs', () => {
  assert.equal(
    matchesSourceGlob(
      'apps/miniapp/src/pages/settings/settings-extra-section.tsx',
      'apps/miniapp/src/pages/settings/**/*.ts*',
    ),
    true,
  );

  const settingsSelection = selectMiniappVisualScenarios({
    changedFiles: ['apps/miniapp/src/styles/settings-route-polish.css'],
  });
  const settingsNames = settingsSelection.scenarios.map((scenario) => scenario.name);
  assert.ok(settingsNames.includes('chat-settings'));
  assert.ok(settingsNames.includes('channel-settings'));
  assert.ok(settingsNames.includes('navigation-home-settings-home'));
  assert.equal(settingsNames.includes('legal-agreement'), false);

  const signatureSelection = selectMiniappVisualScenarios({
    changedFiles: ['apps/miniapp/src/styles/channel-post-signature.css'],
  });
  const signatureNames = signatureSelection.scenarios.map((scenario) => scenario.name);
  assert.ok(signatureNames.includes('channel-settings'));
  assert.ok(signatureNames.includes('channel-settings-post-signature'));
  assert.equal(signatureNames.includes('chat-settings'), false);

  const suggestSelection = selectMiniappVisualScenarios({
    changedFiles: ['apps/miniapp/src/pages/channel-suggest-dialog-page.tsx'],
  });
  const suggestNames = suggestSelection.scenarios.map((scenario) => scenario.name);
  assert.ok(suggestNames.includes('channel-dialog-suggest'));
  assert.ok(suggestNames.includes('channel-settings-post-suggestions'));
  assert.equal(suggestNames.includes('legal-agreement'), false);
});

test('navigation-order metadata preserves the required route sequences', () => {
  const navigation = Object.fromEntries(
    MINIAPP_VISUAL_SCENARIOS.filter((scenario) => scenario.navigation).map((scenario) => [
      scenario.name,
      [scenario.path, ...scenario.navigation.map((step) => step.path)],
    ]),
  );

  assert.deepEqual(navigation, {
    'navigation-home-settings-home': ['/', '/chat/preview-chat/settings', '/'],
    'navigation-publications-settings': ['/publications', '/chat/preview-chat/settings'],
    'navigation-events-stats': ['/chat/preview-chat/events', '/channel/preview-channel/stats'],
  });
});

test('native visual mode removes preview wrapper geometry without styling app content', async () => {
  const elements = new Map([
    ['.design-preview', createFakeElement(['design-preview'])],
    ['.design-preview__dock', createFakeElement(['design-preview__dock', 'glass-card'])],
    ['.design-preview__stage', createFakeElement(['design-preview__stage'])],
    ['.design-preview__device', createFakeElement(['design-preview__device'])],
    ['.design-preview__device-screen', createFakeElement(['design-preview__device-screen'])],
  ]);
  const root = createFakeElement([]);
  const dispatchedEvents: string[] = [];
  const documentValue = {
    documentElement: root,
    querySelector(selector: string) {
      const element = elements.get(selector);
      const className = selector.startsWith('.') ? selector.slice(1) : '';
      return element?.classNames.has(className) ? element : null;
    },
  };
  const windowValue = {
    innerHeight: 844,
    dispatchEvent(event: Event) {
      dispatchedEvents.push(event.type);
      return true;
    },
  };
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const page = {
    async evaluate(
      callback: (profile: { safeTop: number; safeBottom: number }) => unknown,
      profile: { safeTop: number; safeBottom: number },
    ) {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: documentValue,
      });
      Object.defineProperty(globalThis, 'window', { configurable: true, value: windowValue });
      try {
        return callback(profile);
      } finally {
        restoreGlobal('document', previousDocument);
        restoreGlobal('window', previousWindow);
      }
    },
    async waitForTimeout() {},
  };

  const state = await applyNativeVisualMode(page, { safeTop: 47, safeBottom: 34 });

  assert.deepEqual(state, { hadPreviewScaffold: true, previewScaffoldDetached: true });
  assert.equal(root.styleValues.get('--app-safe-top'), '47px');
  assert.equal(root.styleValues.get('--app-safe-bottom'), '34px');
  assert.equal(root.styleValues.get('--app-viewport-height'), '844px');
  assert.equal(root.dataset.maxClient, 'native');
  assert.deepEqual(dispatchedEvents, ['resize']);
  assert.equal(elements.get('.design-preview__dock')?.hidden, true);
  for (const selector of [
    '.design-preview',
    '.design-preview__stage',
    '.design-preview__device',
    '.design-preview__device-screen',
  ]) {
    assert.equal(elements.get(selector)?.style.display, 'contents');
  }
});

test('strict layout checks use the framed device screen as their viewport', () => {
  const script = readFileSync(
    new URL('../../../scripts/capture-miniapp-preview.mjs', import.meta.url),
    'utf8',
  );

  assert.match(
    script,
    /const previewScreen = document\.querySelector\('\.design-preview__device-screen'\)/u,
  );
  assert.match(script, /rect\.top > viewportBottom \+ 2/u);
  assert.match(script, /rect\.bottom > viewportBottom \+ 2/u);
});

function createFakeElement(classNames: string[]) {
  const values = new Set(classNames);
  const styleValues = new Map<string, string>();
  return {
    classNames: values,
    classList: {
      remove(value: string) {
        values.delete(value);
      },
    },
    dataset: {} as Record<string, string>,
    hidden: false,
    style: {
      display: '',
      setProperty(name: string, value: string) {
        styleValues.set(name, value);
      },
    },
    styleValues,
  };
}

function restoreGlobal(name: 'document' | 'window', descriptor?: PropertyDescriptor) {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
    return;
  }
  Reflect.deleteProperty(globalThis, name);
}
