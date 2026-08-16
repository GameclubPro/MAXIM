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

test('smoke preset is short, local-device focused, and includes navigation order', () => {
  const smoke = MINIAPP_VISUAL_PRESETS.smoke;
  assert.ok(smoke.scenarioNames.length >= 8 && smoke.scenarioNames.length <= 12);
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
