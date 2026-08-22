const GLOBAL_SOURCE_GLOBS = [
  'scripts/capture-miniapp-preview.mjs',
  'scripts/miniapp-*.mjs',
  'apps/miniapp/src/app.tsx',
  'apps/miniapp/src/preview-runtime.ts',
  'apps/miniapp/src/components/shell.tsx',
  'apps/miniapp/src/styles/base.css',
  'apps/miniapp/src/styles/components.css',
  'apps/miniapp/src/styles/layout.css',
  'apps/miniapp/src/styles/motion.css',
  'apps/miniapp/src/styles/tokens.css',
];

const FEATURE_SOURCE_GLOBS = {
  broadcast: [
    'apps/miniapp/src/components/broadcast-*.tsx',
    'apps/miniapp/src/components/broadcast-*.css',
    'apps/miniapp/src/styles/broadcast-*.css',
    'apps/miniapp/src/lib/broadcast-*.ts',
  ],
  comments: [
    'apps/miniapp/src/pages/channel-dialog-page.tsx',
    'apps/miniapp/src/styles/channel-dialog-*.css',
  ],
  events: [
    'apps/miniapp/src/pages/events-page.tsx',
    'apps/miniapp/src/styles/dashboard-events.css',
    'apps/miniapp/src/lib/api/events-client.ts',
  ],
  favorite: [
    'apps/miniapp/src/pages/home-entity-sheets.tsx',
    'apps/miniapp/src/lib/home-entity-favorites*.ts',
  ],
  giveaway: [
    'apps/miniapp/src/components/managed-giveaway*.tsx',
    'apps/miniapp/src/pages/giveaway-page.tsx',
    'apps/miniapp/src/styles/*giveaway*.css',
    'apps/miniapp/src/lib/api/*giveaway*.ts',
  ],
  legal: [
    'apps/miniapp/src/pages/legal-page.tsx',
    'apps/miniapp/src/styles/legal-page.css',
    'apps/miniapp/src/lib/public-legal-route.ts',
  ],
  links: [
    'apps/miniapp/src/components/broadcast-link-*.tsx',
    'apps/miniapp/src/styles/settings-link-allowlist.css',
  ],
  publications: [
    'apps/miniapp/src/pages/publications-page.tsx',
    'apps/miniapp/src/styles/publications-page.css',
    'apps/miniapp/src/lib/api/publication-client.ts',
    'apps/miniapp/src/lib/publication-*.ts',
  ],
  settings: [
    'apps/miniapp/src/pages/settings-page*.ts*',
    'apps/miniapp/src/pages/settings/**/*.ts*',
    'apps/miniapp/src/styles/settings-*.css',
    'apps/miniapp/src/components/settings-*.tsx',
  ],
  stats: [
    'apps/miniapp/src/pages/channel-stats-page.tsx',
    'apps/miniapp/src/styles/*stats*.css',
    'apps/miniapp/src/styles/statistics-experience.css',
    'apps/miniapp/src/lib/api/channel-stats-client.ts',
    'apps/miniapp/src/lib/statistics-*.ts',
  ],
  suggest: [
    'apps/miniapp/src/pages/channel-suggest-dialog-page.tsx',
    'apps/miniapp/src/styles/channel-dialog-suggest.css',
  ],
  'vk-parsing': [
    'apps/miniapp/src/components/vk-parsing-card.tsx',
    'apps/miniapp/src/styles/vk-parsing.css',
    'apps/miniapp/src/lib/api/vk-parsing-client.ts',
  ],
};

const ROUTE_DEFINITIONS = {
  home: {
    pattern: '/',
    previewPath: '/',
    manifestEntry: 'src/pages/chats-page.tsx',
    readySelector: '.chats-home',
    coldScenario: 'home',
    features: ['home'],
    sourceGlobs: [
      'apps/miniapp/src/pages/chats-page.tsx',
      'apps/miniapp/src/pages/chats-page*.css',
      'apps/miniapp/src/components/chat-*.tsx',
      'apps/miniapp/src/lib/api/managed-entities-client.ts',
    ],
  },
  publications: {
    pattern: '/publications',
    previewPath: '/publications',
    manifestEntry: 'src/pages/publications-page.tsx',
    readySelector: '.publications-page',
    coldScenario: 'publications',
    features: ['publications'],
    sourceGlobs: FEATURE_SOURCE_GLOBS.publications,
  },
  autoposts: {
    pattern: '/autoposts',
    previewPath: '/autoposts',
    manifestEntry: 'src/pages/publications-page.tsx',
    readySelector: '.publications-page',
    coldScenario: 'autoposts-redirect',
    features: ['publications', 'legacy'],
    sourceGlobs: FEATURE_SOURCE_GLOBS.publications,
  },
  'chat-settings': {
    pattern: '/chat/:chatId/settings',
    previewPath: '/chat/preview-chat/settings',
    manifestEntry: 'src/pages/settings-page.tsx',
    readySelector: '.settings-sections--chat-home',
    coldScenario: 'chat-settings',
    features: ['settings', 'chat'],
    sourceGlobs: FEATURE_SOURCE_GLOBS.settings,
  },
  'channel-settings': {
    pattern: '/channel/:chatId/settings',
    previewPath: '/channel/preview-channel/settings',
    manifestEntry: 'src/pages/channel-settings-page.tsx',
    readySelector: '.channel-settings-screen',
    coldScenario: 'channel-settings',
    features: ['settings', 'channel'],
    sourceGlobs: [
      'apps/miniapp/src/pages/channel-settings-page.tsx',
      'apps/miniapp/src/styles/channel-post-signature.css',
      ...FEATURE_SOURCE_GLOBS.settings,
    ],
  },
  'channel-stats': {
    pattern: '/channel/:chatId/stats',
    previewPath: '/channel/preview-channel/stats',
    manifestEntry: 'src/pages/channel-stats-page.tsx',
    readySelector: '.channel-insights',
    coldScenario: 'channel-stats',
    features: ['stats', 'channel'],
    sourceGlobs: FEATURE_SOURCE_GLOBS.stats,
  },
  'channel-comments': {
    pattern: '/channel/:chatId/dialog/comments',
    previewPath: '/channel/preview-channel/dialog/comments',
    manifestEntry: 'src/pages/channel-dialog-page.tsx',
    readySelector: '.channel-dialog-screen',
    coldScenario: 'channel-dialog-comments',
    features: ['comments', 'channel'],
    sourceGlobs: FEATURE_SOURCE_GLOBS.comments,
  },
  'chat-comments': {
    pattern: '/chat/:chatId/dialog/comments',
    previewPath: '/chat/preview-chat/dialog/comments',
    manifestEntry: 'src/pages/channel-dialog-page.tsx',
    readySelector: '.channel-dialog-screen',
    coldScenario: 'chat-dialog-comments',
    features: ['comments', 'chat'],
    sourceGlobs: FEATURE_SOURCE_GLOBS.comments,
  },
  'channel-suggest': {
    pattern: '/channel/:chatId/dialog/suggest',
    previewPath: '/channel/preview-channel/dialog/suggest',
    manifestEntry: 'src/pages/channel-suggest-dialog-page.tsx',
    readySelector: '.channel-dialog-screen--suggest',
    coldScenario: 'channel-dialog-suggest',
    features: ['suggest', 'channel'],
    sourceGlobs: FEATURE_SOURCE_GLOBS.suggest,
  },
  'chat-events': {
    pattern: '/chat/:chatId/events',
    previewPath: '/chat/preview-chat/events',
    manifestEntry: 'src/pages/events-page.tsx',
    readySelector: '.events-screen',
    coldScenario: 'events-moderation',
    features: ['events', 'chat'],
    sourceGlobs: FEATURE_SOURCE_GLOBS.events,
  },
  giveaway: {
    pattern: '/giveaways/:giveawayId',
    previewPath: '/giveaways/preview-giveaway',
    manifestEntry: 'src/pages/giveaway-page.tsx',
    readySelector: '.giveaway-page',
    coldScenario: 'giveaway-default',
    features: ['giveaway'],
    sourceGlobs: FEATURE_SOURCE_GLOBS.giveaway,
  },
  'legal-agreement': {
    pattern: '/legal/agreement',
    previewPath: '/legal/agreement',
    manifestEntry: 'src/pages/legal-page.tsx',
    readySelector: '.legal-page',
    coldScenario: 'legal-agreement',
    features: ['legal'],
    sourceGlobs: FEATURE_SOURCE_GLOBS.legal,
  },
  'legal-privacy': {
    pattern: '/legal/privacy',
    previewPath: '/legal/privacy',
    manifestEntry: 'src/pages/legal-page.tsx',
    readySelector: '.legal-page',
    coldScenario: 'legal-privacy',
    features: ['legal'],
    sourceGlobs: FEATURE_SOURCE_GLOBS.legal,
  },
};

const FEATURE_NAME_MATCHERS = [
  ['activity', /activity/u],
  ['broadcast', /broadcast/u],
  ['comments', /comments/u],
  ['duplicates', /duplicates/u],
  ['favorite', /favorite|filter/u],
  ['giveaway', /giveaway/u],
  ['links', /links|subscription/u],
  ['moderation', /moderation|spam/u],
  ['participants', /participant/u],
  ['polls', /poll/u],
  ['stats', /stats|events/u],
  ['suggest', /suggest/u],
  ['vk-parsing', /vk-parsing/u],
];

export const MINIAPP_RUNTIME_ROUTES = Object.freeze(
  Object.entries(ROUTE_DEFINITIONS).map(([id, route]) =>
    Object.freeze({
      id,
      pattern: route.pattern,
      manifestEntry: route.manifestEntry,
      coldScenario: route.coldScenario,
    }),
  ),
);

export const MINIAPP_VISUAL_BOTTOM_SCENARIO_SOURCES = Object.freeze([
  'chat-settings-rules',
  'chat-settings-profanity',
  'chat-settings-commercial',
  'chat-settings-duplicates',
  'chat-settings-limits',
  'chat-settings-night',
  'chat-settings-commands',
  'chat-settings-speech-style',
  'chat-settings-stop-words',
  'chat-settings-links',
  'chat-settings-links-timer',
  'chat-settings-bot-message-editor',
  'chat-settings-required-subscription',
  'chat-settings-vk-parsing',
  'chat-settings-polls',
  'chat-settings-poll-editor',
  'chat-settings-poll-draft',
  'chat-settings-giveaway',
  'chat-settings-giveaway-editor',
  'chat-settings-giveaway-conditions-step',
  'chat-settings-giveaway-channels-modal',
  'chat-settings-giveaway-publish-step',
  'chat-settings-broadcast-handoff',
  'chat-settings-broadcast-editor',
  'channel-settings-comments',
  'channel-settings-post-suggestions',
  'channel-settings-post-suggestions-off',
  'channel-settings-vk-parsing',
  'channel-settings-polls',
  'channel-settings-poll-editor',
  'channel-settings-giveaway',
  'channel-settings-broadcast-handoff',
  'channel-settings-broadcast-editor',
]);

const baseScenarios = [
  ...defineRouteScenarios('home', [
    'home',
    ['home-channels', { searchParams: { view: 'channel' } }],
    ['home-filter', { searchParams: { view: 'chat' } }],
    ['home-filter-active', { searchParams: { view: 'chat' } }],
    ['home-category-edit', { searchParams: { view: 'chat' } }],
    ['home-favorite-picker', { searchParams: { view: 'chat' } }],
    ['home-favorite-categories', { searchParams: { view: 'chat' } }],
  ]),
  ...defineRouteScenarios('publications', [
    'publications',
    'publications-actions',
    'publications-edit-discard',
    'publications-retry-choice',
    ['publications-legacy', { searchParams: { legacy: '1' }, features: ['legacy'] }],
    [
      'publications-compose',
      {
        searchParams: { compose: '1', entityType: 'chat', entityId: 'preview-chat' },
        features: ['broadcast'],
      },
    ],
  ]),
  defineScenario('autoposts', 'autoposts-redirect', {
    readySelector: '.publications-page',
  }),
  ...defineRouteScenarios('chat-events', [
    'events-moderation',
    'events-moderation-scrolled',
    'events-moderation-expanded',
    ['events-activity', { searchParams: { section: 'activity' } }],
    ['events-participants', { searchParams: { section: 'participants' } }],
    ['events-participant-sheet', { searchParams: { section: 'participants' } }],
    ['events-participant-controls', { searchParams: { section: 'participants' } }],
    'events-spam-review',
    'events-spam-diagnostics',
  ]),
  ...defineRouteScenarios('chat-settings', [
    'chat-settings',
    [
      'chat-settings-auth-expired',
      { searchParams: { settingsError: 'auth-expired' }, readySelector: '.status-state' },
    ],
    [
      'chat-settings-access-denied',
      { searchParams: { settingsError: 'access-denied' }, readySelector: '.status-state' },
    ],
    ['chat-settings-access-lost', { searchParams: { access: 'lost' } }],
    'chat-settings-rules',
    'chat-settings-greeting',
    'chat-settings-profanity',
    'chat-settings-commercial',
    'chat-settings-duplicates',
    'chat-settings-duplicates-photos',
    'chat-settings-duplicates-duration',
    'chat-settings-limits',
    'chat-settings-night',
    'chat-settings-night-time-picker',
    'chat-settings-commands',
    ['chat-settings-storefront', { searchParams: { focus: 'storefront' } }],
    'chat-settings-extra',
    'chat-settings-speech-style',
    ['chat-settings-stop-words', { searchParams: { focus: 'stopWords' } }],
    ['chat-settings-links', { searchParams: { focus: 'links' } }],
    ['chat-settings-bot-message-editor', { searchParams: { focus: 'links' } }],
    ['chat-settings-links-timer', { searchParams: { focus: 'links' } }],
    ['chat-settings-links-button-picker', { searchParams: { focus: 'links' } }],
    ['chat-settings-links-button-sheet', { searchParams: { focus: 'links' } }],
    ['chat-settings-giveaway', { searchParams: { focus: 'giveaway' } }],
    ['chat-settings-polls', { searchParams: { focus: 'polls' } }],
    ['chat-settings-poll-editor', { searchParams: { focus: 'polls' } }],
    ['chat-settings-poll-draft', { searchParams: { focus: 'polls' } }],
    ['chat-settings-poll-published', { searchParams: { focus: 'polls' } }],
    ['chat-settings-giveaway-editor', { searchParams: { focus: 'giveaway' } }],
    ['chat-settings-giveaway-conditions-step', { searchParams: { focus: 'giveaway' } }],
    ['chat-settings-giveaway-channels-modal', { searchParams: { focus: 'giveaway' } }],
    ['chat-settings-giveaway-publish-step', { searchParams: { focus: 'giveaway' } }],
    ['chat-settings-comments', { searchParams: { focus: 'comments' } }],
    ['chat-settings-required-subscription', { searchParams: { focus: 'requiredSubscription' } }],
    ['chat-settings-apply-target', { searchParams: { focus: 'links' } }],
    ['chat-settings-broadcast', { searchParams: { focus: 'broadcast', workspace: 'autoposts' } }],
    ['chat-settings-broadcast-handoff', { searchParams: { focus: 'broadcast', handoff: '1' } }],
    ['chat-settings-broadcast-audience', { searchParams: { focus: 'broadcast', handoff: '1' } }],
    [
      'chat-settings-broadcast-history',
      { searchParams: { focus: 'broadcast', workspace: 'autoposts' } },
    ],
    [
      'chat-settings-broadcast-editor',
      {
        searchParams: {
          focus: 'broadcast',
          legacyKind: 'broadcast',
          legacyId: 'broadcast-preview-1',
        },
      },
    ],
    ['chat-settings-vk-parsing', { searchParams: { focus: 'vkParsing' } }],
  ]),
  ...defineRouteScenarios('chat-comments', [
    ['chat-dialog-comments', { searchParams: { token: 'preview-comments-token-0001' } }],
    [
      'chat-dialog-comments-short-thread',
      { searchParams: { token: 'preview-comments-token-0001', thread: 'short' } },
    ],
    [
      'chat-dialog-comments-empty-thread',
      { searchParams: { token: 'preview-comments-token-0001', thread: 'empty' } },
    ],
  ]),
  defineScenario('channel-comments', 'channel-dialog-comments', {
    searchParams: { token: 'preview-comments-token-0001' },
  }),
  defineScenario('channel-suggest', 'channel-dialog-suggest', {
    searchParams: { token: 'preview-suggest-token-0001' },
  }),
  ...defineRouteScenarios('channel-settings', [
    'channel-settings',
    [
      'channel-settings-auth-expired',
      { searchParams: { settingsError: 'auth-expired' }, readySelector: '.status-state' },
    ],
    [
      'channel-settings-access-denied',
      { searchParams: { settingsError: 'access-denied' }, readySelector: '.status-state' },
    ],
    'channel-settings-post-signature',
    ['channel-settings-access-degraded', { searchParams: { access: 'degraded' } }],
    'channel-settings-comments',
    'channel-settings-post-suggestions',
    'channel-settings-post-suggestions-off',
    ['channel-settings-vk-parsing', { searchParams: { focus: 'vkParsing' } }],
    'channel-settings-vk-parsing-editor',
    'channel-settings-polls',
    'channel-settings-poll-editor',
    'channel-settings-giveaway',
    [
      'channel-settings-broadcast',
      { searchParams: { focus: 'broadcast', workspace: 'autoposts' } },
    ],
    ['channel-settings-broadcast-handoff', { searchParams: { focus: 'broadcast', handoff: '1' } }],
    [
      'channel-settings-broadcast-history',
      { searchParams: { focus: 'broadcast', workspace: 'autoposts' } },
    ],
    [
      'channel-settings-broadcast-editor',
      {
        searchParams: {
          focus: 'broadcast',
          legacyKind: 'broadcast',
          legacyId: 'broadcast-channel-1',
        },
      },
    ],
  ]),
  ...defineRouteScenarios('channel-stats', [
    'channel-stats',
    'channel-stats-24h',
    'channel-stats-top-posts',
    ['channel-events', { searchParams: { section: 'events' }, features: ['events'] }],
  ]),
  defineScenario('legal-agreement', 'legal-agreement', {
    preview: false,
    maxBridge: false,
  }),
  defineScenario('legal-privacy', 'legal-privacy', {
    preview: false,
    maxBridge: false,
  }),
  defineScenario('home', 'init-missing', {
    preview: false,
    maxBridge: false,
    readySelector: '.init-missing-card',
    features: ['authentication'],
  }),
  ...defineRouteScenarios('giveaway', [
    'giveaway-default',
    ['giveaway-blocked', { searchParams: { giveaway_state: 'blocked' } }],
    [
      'giveaway-joined',
      { searchParams: { giveaway_state: 'blocked', giveaway_enter_result: 'joined' } },
    ],
    ['giveaway-winner', { searchParams: { giveaway_state: 'winner' } }],
    ['giveaway-completed', { searchParams: { giveaway_state: 'completed' } }],
  ]),
];

const bottomScenarios = MINIAPP_VISUAL_BOTTOM_SCENARIO_SOURCES.map((sourceName) => {
  const source = findScenario(baseScenarios, sourceName);
  return cloneScenario(source, `${sourceName}-bottom`, ['bottom-state']);
});

const favoriteCategoriesBottom = cloneScenario(
  findScenario(baseScenarios, 'home-favorite-categories'),
  'home-favorite-categories-bottom',
  ['bottom-state'],
);

const navigationScenarios = [
  defineNavigationScenario('navigation-home-settings-home', 'home', [
    { routeId: 'chat-settings' },
    { routeId: 'home' },
  ]),
  defineNavigationScenario('navigation-publications-settings', 'publications', [
    { routeId: 'chat-settings' },
  ]),
  defineNavigationScenario('navigation-events-stats', 'chat-events', [
    { routeId: 'channel-stats' },
  ]),
];

export const MINIAPP_VISUAL_SCENARIOS = Object.freeze([
  ...baseScenarios,
  ...bottomScenarios,
  favoriteCategoriesBottom,
  ...navigationScenarios,
]);

export const MINIAPP_VISUAL_PRESETS = Object.freeze({
  smoke: Object.freeze({
    device: 'iphone',
    target: 'native',
    checks: Object.freeze({
      layout: true,
      contrast: true,
      accessibility: true,
    }),
    scenarioNames: Object.freeze([
      'home',
      'publications',
      'chat-settings',
      'channel-settings',
      'channel-stats',
      'events-moderation',
      'channel-dialog-suggest',
      'giveaway-default',
      'legal-agreement',
      'navigation-home-settings-home',
    ]),
  }),
});

export function selectMiniappVisualScenarios(options = {}) {
  const scenarioNames = normalizeList(options.scenarioNames);
  const changedFiles = normalizeList(options.changedFiles).map(normalizeSourcePath);
  const preset = String(options.preset ?? '')
    .trim()
    .toLowerCase();

  if (scenarioNames.length > 0) {
    return {
      reason: 'explicit',
      changedFiles,
      scenarios: selectByNames(scenarioNames),
    };
  }

  if (changedFiles.length > 0) {
    const scenarios = MINIAPP_VISUAL_SCENARIOS.filter((scenario) =>
      scenario.sourceGlobs.some((glob) =>
        changedFiles.some((file) => matchesSourceGlob(file, glob)),
      ),
    );
    return { reason: 'changed-files', changedFiles, scenarios };
  }

  if (preset) {
    const definition = MINIAPP_VISUAL_PRESETS[preset];
    if (!definition) {
      throw new Error(
        `Unknown visual preset ${preset}. Available presets: ${Object.keys(MINIAPP_VISUAL_PRESETS).join(', ')}`,
      );
    }
    return {
      reason: `preset:${preset}`,
      changedFiles,
      scenarios: selectByNames(definition.scenarioNames),
    };
  }

  return { reason: 'all', changedFiles, scenarios: [...MINIAPP_VISUAL_SCENARIOS] };
}

export function findMissingColdRuntimeRoutes(scenarios = MINIAPP_VISUAL_SCENARIOS) {
  const names = new Set(
    scenarios.filter((scenario) => scenario.cold).map((scenario) => scenario.name),
  );
  return MINIAPP_RUNTIME_ROUTES.filter((route) => !names.has(route.coldScenario));
}

export function matchesSourceGlob(sourcePath, glob) {
  return globToRegExp(normalizeSourcePath(glob)).test(normalizeSourcePath(sourcePath));
}

function defineRouteScenarios(routeId, definitions) {
  return definitions.map((definition) => {
    if (typeof definition === 'string') {
      return defineScenario(routeId, definition);
    }
    return defineScenario(routeId, definition[0], definition[1]);
  });
}

function defineScenario(routeId, name, options = {}) {
  const route = ROUTE_DEFINITIONS[routeId];
  if (!route) {
    throw new Error(`Unknown mini app runtime route: ${routeId}`);
  }

  const {
    features: explicitFeatures = [],
    presets = [],
    path = route.previewPath,
    readySelector = route.readySelector,
    ...runtime
  } = options;
  const inferredFeatures = FEATURE_NAME_MATCHERS.filter(([, pattern]) => pattern.test(name)).map(
    ([feature]) => feature,
  );
  const features = unique([...route.features, ...inferredFeatures, ...explicitFeatures]);
  const sourceGlobs = unique([
    ...GLOBAL_SOURCE_GLOBS,
    ...route.sourceGlobs,
    ...features.flatMap((feature) => FEATURE_SOURCE_GLOBS[feature] ?? []),
  ]);

  return Object.freeze({
    name,
    path,
    routeId,
    features: Object.freeze(features),
    sourceGlobs: Object.freeze(sourceGlobs),
    tags: Object.freeze([`route:${routeId}`, ...features.map((feature) => `feature:${feature}`)]),
    cold: route.coldScenario === name,
    presets: Object.freeze([...presets]),
    readySelector,
    ...runtime,
  });
}

function defineNavigationScenario(name, initialRouteId, steps) {
  const initialRoute = ROUTE_DEFINITIONS[initialRouteId];
  const navigation = steps.map(({ routeId, searchParams }) => {
    const route = ROUTE_DEFINITIONS[routeId];
    return Object.freeze({
      routeId,
      path: route.previewPath,
      readySelector: route.readySelector,
      ...(searchParams ? { searchParams } : {}),
    });
  });
  const routeSequence = [initialRouteId, ...navigation.map((step) => step.routeId)];
  const routeIds = unique(routeSequence);
  const features = unique([
    'navigation',
    ...routeIds.flatMap((routeId) => ROUTE_DEFINITIONS[routeId].features),
  ]);
  const sourceGlobs = unique([
    ...GLOBAL_SOURCE_GLOBS,
    ...routeIds.flatMap((routeId) => ROUTE_DEFINITIONS[routeId].sourceGlobs),
  ]);

  return Object.freeze({
    name,
    path: initialRoute.previewPath,
    routeId: `navigation:${routeSequence.join('>')}`,
    features: Object.freeze(features),
    sourceGlobs: Object.freeze(sourceGlobs),
    tags: Object.freeze(['navigation-order', ...routeIds.map((routeId) => `route:${routeId}`)]),
    cold: false,
    presets: Object.freeze([]),
    readySelector: initialRoute.readySelector,
    navigation: Object.freeze(navigation),
  });
}

function cloneScenario(source, name, extraFeatures) {
  const features = unique([...source.features, ...extraFeatures]);
  return Object.freeze({
    ...source,
    name,
    features: Object.freeze(features),
    tags: Object.freeze([...source.tags, ...extraFeatures.map((feature) => `feature:${feature}`)]),
    cold: false,
  });
}

function findScenario(scenarios, name) {
  const scenario = scenarios.find((candidate) => candidate.name === name);
  if (!scenario) {
    throw new Error(`Missing visual scenario metadata: ${name}`);
  }
  return scenario;
}

function selectByNames(names) {
  const missing = names.filter(
    (name) => !MINIAPP_VISUAL_SCENARIOS.some((scenario) => scenario.name === name),
  );
  if (missing.length > 0) {
    throw new Error(`Unknown screenshot scenarios: ${missing.join(', ')}`);
  }
  return unique(names).map((name) =>
    MINIAPP_VISUAL_SCENARIOS.find((scenario) => scenario.name === name),
  );
}

function normalizeList(values) {
  if (Array.isArray(values)) {
    return values.map((value) => String(value).trim()).filter(Boolean);
  }
  return String(values ?? '')
    .split(/[\n,]/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeSourcePath(value) {
  return String(value).trim().replaceAll('\\', '/').replace(/^\.\//u, '');
}

function globToRegExp(glob) {
  let pattern = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === '*' && glob[index + 1] === '*') {
      const followedBySlash = glob[index + 2] === '/';
      pattern += followedBySlash ? '(?:.*/)?' : '.*';
      index += followedBySlash ? 2 : 1;
      continue;
    }
    if (character === '*') {
      pattern += '[^/]*';
      continue;
    }
    if (character === '?') {
      pattern += '[^/]';
      continue;
    }
    pattern += /[.+^${}()|[\]\\]/u.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`${pattern}$`, 'u');
}

function unique(values) {
  return [...new Set(values)];
}
