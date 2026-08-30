import { Injectable } from '@nestjs/common';
import { MaxBotExecutionPlannerService } from '../max/max-bot-execution-planner.service';
import {
  MaxBotLinkService,
  type MaxStrictModerationCapabilityRoute,
} from '../max/max-bot-link.service';
import {
  BotCapabilityCheckUnavailableException,
  BotCapabilityRequiredException,
} from './bot-capability-required.error';
import type { ChatSettingsBotCapabilityRequirement } from './chat-settings-bot-capability';

type CapabilityDependencies = {
  maxBotLinkService?: Pick<
    MaxBotLinkService,
    'resolveStrictMemberModerationBotRoute' | 'resolveStrictWriteModerationBotRoute'
  >;
  maxBotExecutionPlanner?: Pick<MaxBotExecutionPlannerService, 'refreshChatBotCapabilitySnapshots'>;
};

type CapabilityRoute = MaxStrictModerationCapabilityRoute | undefined;
type CapabilityLogger = { warn: (context: unknown, message: string) => void };

function uniqueFeatureKeys(
  requirements: readonly ChatSettingsBotCapabilityRequirement[],
): string[] {
  return requirements
    .flatMap((requirement) => requirement.featureKeys)
    .filter((featureKey, index, values) => values.indexOf(featureKey) === index);
}

function latestCheckedAt(routes: readonly CapabilityRoute[]): string | null {
  return routes.reduce<string | null>((latest, route) => {
    const checkedAt = route?.checkedAt;
    if (!checkedAt || !Number.isFinite(Date.parse(checkedAt))) {
      return latest;
    }
    return !latest || Date.parse(checkedAt) > Date.parse(latest) ? checkedAt : latest;
  }, null);
}

function wasCheckedDuringRefresh(route: CapabilityRoute, refreshStartedAt: Date): boolean {
  const checkedAtMs = route?.checkedAt ? Date.parse(route.checkedAt) : Number.NaN;
  return Number.isFinite(checkedAtMs) && checkedAtMs >= refreshStartedAt.getTime();
}

export async function assertAdminSettingsBotCapabilities(
  dependencies: CapabilityDependencies,
  chatId: string,
  requirements: readonly ChatSettingsBotCapabilityRequirement[],
  options: { forceLive?: boolean } = {},
): Promise<void> {
  if (requirements.length === 0) {
    return;
  }

  const requiredPermissions = new Set(requirements.map((requirement) => requirement.permission));
  const readRoutes = async () => {
    const [member, write] = await Promise.all([
      requiredPermissions.has('add_remove_members')
        ? dependencies.maxBotLinkService?.resolveStrictMemberModerationBotRoute({ chatId })
        : undefined,
      requiredPermissions.has('write')
        ? dependencies.maxBotLinkService?.resolveStrictWriteModerationBotRoute({ chatId })
        : undefined,
    ]);
    return { member, write };
  };

  let routes: Awaited<ReturnType<typeof readRoutes>>;
  try {
    routes = await readRoutes();
  } catch {
    throw new BotCapabilityCheckUnavailableException({
      featureKeys: uniqueFeatureKeys(requirements),
    });
  }
  const initialRoutes = [
    ...(requiredPermissions.has('add_remove_members') ? [routes.member] : []),
    ...(requiredPermissions.has('write') ? [routes.write] : []),
  ];
  const needsRefresh =
    options.forceLive === true ||
    initialRoutes.some((route) => route?.capabilityState === 'stale_or_unknown' || !route);
  let refreshStartedAt: Date | null = null;

  if (needsRefresh) {
    const planner = dependencies.maxBotExecutionPlanner;
    if (!planner) {
      throw new BotCapabilityCheckUnavailableException({
        featureKeys: uniqueFeatureKeys(requirements),
        checkedAt: latestCheckedAt(initialRoutes),
      });
    }
    refreshStartedAt = new Date();
    try {
      await planner.refreshChatBotCapabilitySnapshots({
        chatId,
        entityType: 'chat',
        force: options.forceLive === true,
      });
    } catch {
      throw new BotCapabilityCheckUnavailableException({
        featureKeys: uniqueFeatureKeys(requirements),
        checkedAt: latestCheckedAt(initialRoutes),
      });
    }
    try {
      routes = await readRoutes();
    } catch {
      throw new BotCapabilityCheckUnavailableException({
        featureKeys: uniqueFeatureKeys(requirements),
        checkedAt: latestCheckedAt(initialRoutes),
      });
    }
  }

  const missingPermissions = new Set<ChatSettingsBotCapabilityRequirement['permission']>();
  let uncertain = false;
  for (const [permission, route] of [
    ['add_remove_members', routes.member],
    ['write', routes.write],
  ] as const) {
    if (!requiredPermissions.has(permission)) {
      continue;
    }
    if (
      refreshStartedAt &&
      options.forceLive &&
      !wasCheckedDuringRefresh(route, refreshStartedAt)
    ) {
      uncertain = true;
    } else if (route?.botId) {
      continue;
    } else if (route?.capabilityState === 'explicitly_incapable') {
      missingPermissions.add(permission);
    } else {
      uncertain = true;
    }
  }

  const checkedAt = latestCheckedAt([routes.member, routes.write]);
  if (uncertain) {
    throw new BotCapabilityCheckUnavailableException({
      featureKeys: uniqueFeatureKeys(requirements),
      checkedAt,
    });
  }
  if (missingPermissions.size === 0) {
    return;
  }

  throw new BotCapabilityRequiredException({
    missingPermissions: requirements
      .map((requirement) => requirement.permission)
      .filter(
        (permission, index, values) =>
          missingPermissions.has(permission) && values.indexOf(permission) === index,
      ),
    featureKeys: requirements
      .filter((requirement) => missingPermissions.has(requirement.permission))
      .flatMap((requirement) => requirement.featureKeys)
      .filter((featureKey, index, values) => values.indexOf(featureKey) === index),
    checkedAt,
  });
}

export async function refreshAdminSettingsBotCapabilitySnapshots(
  planner: CapabilityDependencies['maxBotExecutionPlanner'],
  logger: CapabilityLogger,
  chatId: string,
  entityType: 'chat' | 'channel',
  reason: string,
): Promise<void> {
  if (!planner) {
    return;
  }
  try {
    await planner.refreshChatBotCapabilitySnapshots({ chatId, entityType });
  } catch (error: unknown) {
    logger.warn(
      {
        chatId,
        entityType,
        reason,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to refresh bot access snapshots after settings update',
    );
  }
}

@Injectable()
export class AdminSettingsBotCapabilityService {
  constructor(
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly maxBotExecutionPlanner: MaxBotExecutionPlannerService,
  ) {}

  assertChatSettingsBotCapabilities(
    chatId: string,
    requirements: readonly ChatSettingsBotCapabilityRequirement[],
    options: { forceLive?: boolean } = {},
  ): Promise<void> {
    return assertAdminSettingsBotCapabilities(
      {
        maxBotLinkService: this.maxBotLinkService,
        maxBotExecutionPlanner: this.maxBotExecutionPlanner,
      },
      chatId,
      requirements,
      options,
    );
  }
}
