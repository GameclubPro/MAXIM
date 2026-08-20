import { ConfigService } from '@nestjs/config';
import {
  ChatBotAccessState,
  ChatBotMembershipRole,
  ChatBotMembershipStatus,
  ChatEntityType,
  ChatRoutingState,
  createPrismaClient,
} from '../prisma/prisma-client';
import { MaxBotContextService } from '../max/max-bot-context.service';
import { MaxBotLinkService, type MaxBotRoute } from '../max/max-bot-link.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import type { MaxBotDefinition } from '../max/max-bot-registry.service';
import { ModerationDeleteIntentAccessWakeService } from '../max/moderation-delete-intent-access-wake.service';

const ROUTE_MATRIX_BOT_IDS = [
  'id613002203036_bot',
  'id613002203036_4_bot',
  'id613002203036_5_bot',
  'id613070470872_5_bot',
  'id613070470872_6_bot',
  'id613070470872_9_bot',
] as const;

type SmokeMode = 'fixture' | 'db';
type SmokeStatus = 'PASS' | 'DEGRADED' | 'FAIL';

type CliOptions = {
  json: boolean;
  mode: SmokeMode;
  chatId: string | null;
};

type Assertion = {
  scenario: string;
  name: string;
  pass: boolean;
  expected?: unknown;
  actual?: unknown;
};

type SmokeScenario = {
  name: string;
  chatId: string;
  botCount: number;
  routes: MaxBotRoute[];
  assertions: Assertion[];
  warnings: string[];
};

type SmokeResult = {
  generatedAt: string;
  mode: SmokeMode;
  status: SmokeStatus;
  scenarios: SmokeScenario[];
  assertions: Assertion[];
  warnings: string[];
};

type FixtureChat = {
  id: string;
  title: string;
  entityType: ChatEntityType;
  routingState?: ChatRoutingState;
  routingVersion?: number;
  primaryBotId: string | null;
  botId: string | null;
  botMemberships: FixtureMembership[];
};

type FixtureMembership = {
  botId: string;
  role: ChatBotMembershipRole;
  status: ChatBotMembershipStatus;
  botAccessState: ChatBotAccessState;
  botAccessCheckedAt: Date;
  botAccessExpiresAt: Date;
  capabilities: string[];
  permissionsSnapshot: unknown;
};

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    mode: 'fixture',
    chatId: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--fixture') {
      options.mode = 'fixture';
      continue;
    }
    if (arg === '--db') {
      options.mode = 'db';
      continue;
    }
    if (arg === '--chat-id') {
      const value = argv[index + 1];
      index += 1;
      options.chatId = value?.trim() || null;
      continue;
    }
    if (arg.startsWith('--chat-id=')) {
      options.chatId = arg.slice('--chat-id='.length).trim() || null;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.mode === 'db' && !options.chatId) {
    throw new Error('--db requires --chat-id <chat-id>');
  }

  return options;
}

export async function runSmoke(options: CliOptions): Promise<SmokeResult> {
  if (options.mode === 'db') {
    return runDbSmoke(options.chatId!);
  }
  return runFixtureSmoke();
}

export async function runFixtureSmoke(): Promise<SmokeResult> {
  const scenarios: SmokeScenario[] = [];
  for (const botCount of [1, 2, 3, 6]) {
    scenarios.push(await runMatrixScenario(botCount));
  }
  scenarios.push(await runDeniedPrimaryScenario());
  scenarios.push(await runChannelDeletePermissionScenario());
  scenarios.push(await runDrainingScenario());

  return buildResult('fixture', scenarios);
}

async function runMatrixScenario(botCount: number): Promise<SmokeScenario> {
  const chatId = `chat-route-matrix-${botCount}`;
  const botIds = ROUTE_MATRIX_BOT_IDS.slice(0, botCount);
  const primaryBotId = botIds[0]!;
  const fixture = createFixture([
    {
      id: chatId,
      title: `Matrix ${botCount}`,
      entityType: ChatEntityType.CHAT,
      primaryBotId,
      botId: primaryBotId,
      botMemberships: botIds.map((botId, index) =>
        createMembership(chatId, botId, index === 0 ? 'primary' : 'standby'),
      ),
    },
  ]);
  const routes = await resolveRouteSet(fixture.service, chatId);
  const assertions = [
    expectRouteBot(routes, 'send_message', null, null, primaryBotId),
    expectRouteCandidates(routes, 'send_message', null, null, botIds),
    expectRouteBot(routes, 'moderation_action', 'delete_message', null, primaryBotId),
    expectRouteCandidates(routes, 'moderation_action', 'delete_message', null, botIds),
  ];
  return {
    name: `matrix-${botCount}`,
    chatId,
    botCount,
    routes,
    assertions,
    warnings: [],
  };
}

async function runDeniedPrimaryScenario(): Promise<SmokeScenario> {
  const chatId = 'chat-denied-primary';
  const fixture = createFixture([
    {
      id: chatId,
      title: 'Denied primary',
      entityType: ChatEntityType.CHAT,
      primaryBotId: ROUTE_MATRIX_BOT_IDS[0],
      botId: ROUTE_MATRIX_BOT_IDS[0],
      botMemberships: [
        createMembership(chatId, ROUTE_MATRIX_BOT_IDS[0], 'primary', {
          permissionsSnapshot: deniedSnapshot(),
        }),
        createMembership(chatId, ROUTE_MATRIX_BOT_IDS[1], 'standby'),
        createMembership(chatId, ROUTE_MATRIX_BOT_IDS[2], 'standby'),
      ],
    },
  ]);
  const routes = await resolveRouteSet(fixture.service, chatId);
  const sendRoute = findRoute(routes, 'send_message');
  const assertions = [
    assert(
      'denied-primary',
      'send_message skips explicitly denied primary',
      sendRoute?.candidateBotIds.includes(ROUTE_MATRIX_BOT_IDS[0]) === false,
      false,
      sendRoute?.candidateBotIds.includes(ROUTE_MATRIX_BOT_IDS[0]),
    ),
    expectRouteBot(routes, 'send_message', null, null, ROUTE_MATRIX_BOT_IDS[1]),
  ];
  return {
    name: 'denied-primary',
    chatId,
    botCount: 3,
    routes,
    assertions,
    warnings: [],
  };
}

async function runChannelDeletePermissionScenario(): Promise<SmokeScenario> {
  const chatId = 'channel-delete-permission';
  const fixture = createFixture([
    {
      id: chatId,
      title: 'Channel delete permission',
      entityType: ChatEntityType.CHANNEL,
      primaryBotId: ROUTE_MATRIX_BOT_IDS[0],
      botId: ROUTE_MATRIX_BOT_IDS[0],
      botMemberships: [
        createMembership(chatId, ROUTE_MATRIX_BOT_IDS[0], 'primary', {
          permissionsSnapshot: writeOnlySnapshot(),
        }),
        createMembership(chatId, ROUTE_MATRIX_BOT_IDS[1], 'standby', {
          permissionsSnapshot: deleteOnlySnapshot(),
        }),
      ],
    },
  ]);
  const routes = await resolveRouteSet(fixture.service, chatId);
  const deleteRoute = findRoute(routes, 'moderation_action', 'delete_message');
  const assertions = [
    expectRouteBot(routes, 'moderation_action', 'delete_message', null, ROUTE_MATRIX_BOT_IDS[1]),
    assert(
      'channel-delete-permission',
      'channel write-only primary is not a delete candidate',
      deleteRoute?.candidateBotIds.includes(ROUTE_MATRIX_BOT_IDS[0]) === false,
      false,
      deleteRoute?.candidateBotIds.includes(ROUTE_MATRIX_BOT_IDS[0]),
    ),
  ];
  return {
    name: 'channel-delete-permission',
    chatId,
    botCount: 2,
    routes,
    assertions,
    warnings: [],
  };
}

async function runDrainingScenario(): Promise<SmokeScenario> {
  const chatId = 'chat-draining-standby';
  const fixture = createFixture(
    [
      {
        id: chatId,
        title: 'Draining standby',
        entityType: ChatEntityType.CHAT,
        primaryBotId: ROUTE_MATRIX_BOT_IDS[0],
        botId: ROUTE_MATRIX_BOT_IDS[0],
        botMemberships: [
          createMembership(chatId, ROUTE_MATRIX_BOT_IDS[0], 'primary'),
          createMembership(chatId, ROUTE_MATRIX_BOT_IDS[1], 'standby'),
          createMembership(chatId, ROUTE_MATRIX_BOT_IDS[2], 'standby'),
        ],
      },
    ],
    { [ROUTE_MATRIX_BOT_IDS[1]]: 'draining' },
  );
  const routes = await resolveRouteSet(fixture.service, chatId);
  const sendRoute = findRoute(routes, 'send_message');
  const readRoute = findRoute(routes, 'read');
  const assertions = [
    assert(
      'draining-standby',
      'send_message excludes draining standby',
      sendRoute?.candidateBotIds.includes(ROUTE_MATRIX_BOT_IDS[1]) === false,
      false,
      sendRoute?.candidateBotIds.includes(ROUTE_MATRIX_BOT_IDS[1]),
    ),
    assert(
      'draining-standby',
      'read route remains resolved while a standby is draining',
      Boolean(readRoute?.botId),
      true,
      readRoute?.botId ?? null,
    ),
  ];
  return {
    name: 'draining-standby',
    chatId,
    botCount: 3,
    routes,
    assertions,
    warnings: [],
  };
}

async function runDbSmoke(chatId: string): Promise<SmokeResult> {
  const prisma = createPrismaClient();
  try {
    const registry = new MaxBotRegistryService(createEnvConfigService());
    const service = new MaxBotLinkService(
      prisma as never,
      registry,
      {
        getActiveBotId: () => null,
      } as MaxBotContextService,
      new ModerationDeleteIntentAccessWakeService(prisma as never),
    );
    const routes = await resolveRouteSet(service, chatId);
    const assertions = [
      assert(
        'db-route',
        'at least one route resolves a selected bot',
        routes.some((route) => route.botId),
        true,
        routes,
      ),
    ];
    const scenario: SmokeScenario = {
      name: 'db-route',
      chatId,
      botCount: registry.getAllBots().length,
      routes,
      assertions,
      warnings: buildDbRouteWarnings(routes),
    };
    return buildResult('db', [scenario]);
  } finally {
    await prisma.$disconnect();
  }
}

export function buildDbRouteWarnings(routes: readonly MaxBotRoute[]): string[] {
  const requiredRoutes = [
    findRoute(routes, 'send_message'),
    findRoute(routes, 'moderation_action', 'delete_message'),
    findRoute(routes, 'moderation_action', 'moderate_member'),
  ];
  const missingRequiredRoutes = requiredRoutes
    .filter((route) => !route?.botId)
    .map((route) => (route ? formatRouteName(route) : 'unknown'));

  if (missingRequiredRoutes.length === 0) {
    return [];
  }

  return [
    `Required action routes have no selected bot from local DB state: ${missingRequiredRoutes.join(', ')}.`,
  ];
}

function createFixture(
  chats: FixtureChat[],
  stateOverrides: Record<string, MaxBotDefinition['state']> = {},
) {
  const chatById = new Map(chats.map((chat) => [chat.id, chat]));
  const bots = ROUTE_MATRIX_BOT_IDS.map((id, index) =>
    createBotDefinition(id, index, stateOverrides[id] ?? 'active'),
  );
  const registry = {
    getBotById: (botId?: string | null) => bots.find((bot) => bot.id === botId) ?? null,
    getDefaultBot: () => bots[0]!,
    getEntryBot: () => bots[0]!,
  };
  const prisma = {
    chat: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const chat = chatById.get(where.id);
        if (!chat) {
          return null;
        }
        return {
          entityType: chat.entityType,
          routingState: chat.routingState ?? ChatRoutingState.READY,
          routingVersion: chat.routingVersion ?? 0,
          primaryBotId: chat.primaryBotId,
          botId: chat.botId,
          botMemberships: chat.botMemberships.map((membership) => ({
            botId: membership.botId,
            role: membership.role,
            status: membership.status,
            botAccessState: membership.botAccessState,
            botAccessCheckedAt: membership.botAccessCheckedAt,
            botAccessExpiresAt: membership.botAccessExpiresAt,
            capabilities: membership.capabilities,
            permissionsSnapshot: membership.permissionsSnapshot,
          })),
        };
      },
    },
  };
  return {
    service: new MaxBotLinkService(
      prisma as never,
      registry as never,
      { getActiveBotId: () => null } as MaxBotContextService,
      new ModerationDeleteIntentAccessWakeService(prisma as never),
    ),
  };
}

function createMembership(
  _chatId: string,
  botId: string,
  role: 'primary' | 'standby',
  overrides: Partial<FixtureMembership> = {},
): FixtureMembership {
  return {
    botId,
    role: role === 'primary' ? ChatBotMembershipRole.PRIMARY : ChatBotMembershipRole.STANDBY,
    status: ChatBotMembershipStatus.ACTIVE,
    botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
    botAccessCheckedAt: new Date('2026-07-06T10:00:00.000Z'),
    botAccessExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
    capabilities: role === 'standby' ? ['suggestion_delivery'] : [],
    permissionsSnapshot: adminSnapshot(),
    ...overrides,
  };
}

function adminSnapshot() {
  return {
    checkedAt: '2026-07-06T10:00:00.000Z',
    isAdmin: true,
    isOwner: false,
    permissions: ['read_all_messages', 'write', 'delete_messages', 'add_remove_members'],
  };
}

function deniedSnapshot() {
  return {
    checkedAt: '2026-07-06T10:00:00.000Z',
    isAdmin: false,
    isOwner: false,
    permissions: [],
  };
}

function writeOnlySnapshot() {
  return {
    checkedAt: '2026-07-06T10:00:00.000Z',
    isAdmin: true,
    isOwner: false,
    permissions: ['write'],
  };
}

function deleteOnlySnapshot() {
  return {
    checkedAt: '2026-07-06T10:00:00.000Z',
    isAdmin: true,
    isOwner: false,
    permissions: ['read_all_messages', 'delete'],
  };
}

function createBotDefinition(
  id: string,
  index: number,
  state: MaxBotDefinition['state'],
): MaxBotDefinition {
  return {
    id,
    label: `Bot ${index + 1}`,
    characterName: `Bot ${index + 1}`,
    speechPersona: 'male',
    token: `token-${index + 1}`,
    tokenValidationSecrets: [`token-${index + 1}`],
    webhookSecretPath: `secret-${index + 1}`,
    webhookHeaderSecret: `header-${index + 1}`,
    webhookHeaderSecrets: [`header-${index + 1}`],
    contactId: `${id}-contact`,
    state,
    ownershipWeight: 1,
    visibleInAdmin: state !== 'disabled',
    isDefault: index === 0,
    webhookUrl: null,
    maskedWebhookUrl: null,
  };
}

async function resolveRouteSet(service: MaxBotLinkService, chatId: string): Promise<MaxBotRoute[]> {
  return Promise.all([
    service.resolveBotRoute({ purpose: 'default', chatId }),
    service.resolveBotRoute({ purpose: 'read', chatId }),
    service.resolveBotRoute({ purpose: 'member_access', chatId }),
    service.resolveBotRoute({ purpose: 'send_message', chatId }),
    service.resolveBotRoute({ purpose: 'moderation_action', chatId, action: 'delete_message' }),
    service.resolveBotRoute({ purpose: 'moderation_action', chatId, action: 'moderate_member' }),
    service.resolveBotRoute({
      purpose: 'capability',
      chatId,
      capability: 'suggestion_delivery',
    }),
  ]);
}

function findRoute(
  routes: readonly MaxBotRoute[],
  purpose: MaxBotRoute['purpose'],
  action?: string | null,
  capability?: string | null,
): MaxBotRoute | null {
  return (
    routes.find((route) => {
      if (route.purpose !== purpose) {
        return false;
      }
      if (route.purpose === 'moderation_action') {
        return action === undefined || route.action === action;
      }
      if (route.purpose === 'capability') {
        return capability === undefined || route.capability === capability;
      }
      return true;
    }) ?? null
  );
}

function expectRouteBot(
  routes: readonly MaxBotRoute[],
  purpose: MaxBotRoute['purpose'],
  action: string | null,
  capability: string | null,
  expectedBotId: string,
): Assertion {
  const route = findRoute(routes, purpose, action, capability);
  return assert(
    routeKey(purpose, action, capability),
    'selected bot',
    route?.botId === expectedBotId,
    expectedBotId,
    route?.botId ?? null,
  );
}

function expectRouteCandidates(
  routes: readonly MaxBotRoute[],
  purpose: MaxBotRoute['purpose'],
  action: string | null,
  capability: string | null,
  expectedBotIds: readonly string[],
): Assertion {
  const route = findRoute(routes, purpose, action, capability);
  return assert(
    routeKey(purpose, action, capability),
    'candidate bot ids',
    JSON.stringify(route?.candidateBotIds ?? []) === JSON.stringify(expectedBotIds),
    expectedBotIds,
    route?.candidateBotIds ?? [],
  );
}

function routeKey(
  purpose: MaxBotRoute['purpose'],
  action: string | null,
  capability: string | null,
) {
  if (purpose === 'moderation_action') {
    return `${purpose}/${action ?? 'any'}`;
  }
  if (purpose === 'capability') {
    return `${purpose}/${capability ?? 'any'}`;
  }
  return purpose;
}

function assert(
  scenario: string,
  name: string,
  pass: boolean,
  expected?: unknown,
  actual?: unknown,
): Assertion {
  return {
    scenario,
    name,
    pass,
    expected,
    actual,
  };
}

function buildResult(mode: SmokeMode, scenarios: SmokeScenario[]): SmokeResult {
  const assertions = scenarios.flatMap((scenario) => scenario.assertions);
  const warnings = scenarios.flatMap((scenario) => scenario.warnings);
  return {
    generatedAt: new Date().toISOString(),
    mode,
    status: assertions.some((assertion) => !assertion.pass)
      ? 'FAIL'
      : warnings.length > 0
        ? 'DEGRADED'
        : 'PASS',
    scenarios,
    assertions,
    warnings,
  };
}

export function renderText(result: SmokeResult): string {
  const lines = [
    `Multi-bot route smoke: ${result.status}`,
    `mode=${result.mode} generatedAt=${result.generatedAt}`,
    '',
  ];
  for (const scenario of result.scenarios) {
    lines.push(`scenario=${scenario.name} chatId=${scenario.chatId} bots=${scenario.botCount}`);
    lines.push(
      'purpose                         selected              primary               candidates',
    );
    for (const route of scenario.routes) {
      lines.push(
        `${formatRouteName(route).padEnd(31)} ${String(route.botId ?? '-').padEnd(21)} ${String(route.primaryBotId ?? '-').padEnd(21)} [${route.candidateBotIds.join(',')}]`,
      );
    }
    for (const failed of scenario.assertions.filter((assertion) => !assertion.pass)) {
      lines.push(
        `FAIL ${failed.scenario}: ${failed.name}; expected=${JSON.stringify(failed.expected)} actual=${JSON.stringify(failed.actual)}`,
      );
    }
    lines.push('');
  }
  lines.push(
    `assertions=${result.assertions.length} passed=${result.assertions.filter((item) => item.pass).length} failed=${result.assertions.filter((item) => !item.pass).length} warnings=${result.warnings.length}`,
  );
  for (const warning of result.warnings) {
    lines.push(`warning: ${warning}`);
  }
  return lines.join('\n');
}

function formatRouteName(route: MaxBotRoute): string {
  if (route.purpose === 'moderation_action') {
    return `${route.purpose}/${route.action}`;
  }
  if (route.purpose === 'capability') {
    return `${route.purpose}/${route.capability}`;
  }
  return route.purpose;
}

function createEnvConfigService(): ConfigService {
  return {
    get: (key: string, fallback?: unknown) => process.env[key] ?? fallback,
    getOrThrow: (key: string) => {
      const value = process.env[key];
      if (!value?.trim()) {
        throw new Error(`${key} is required`);
      }
      return value;
    },
  } as ConfigService;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await runSmoke(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderText(result)}\n`);
    }
    process.exitCode = result.status === 'PASS' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
