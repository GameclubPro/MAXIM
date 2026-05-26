import type { BotOwnershipLifecycleStats } from '@maxim/contracts';
import type { MaxBotLifecycleState } from './max-bot-config.util';

type MaxBotLifecyclePolicy = {
  operational: boolean;
  executable: boolean;
  discoverable: boolean;
  adminVisibleByDefault: boolean;
};

type BotLifecycleStatsInput = {
  state: MaxBotLifecycleState;
  visibleInAdmin?: boolean;
};

const MAX_BOT_LIFECYCLE_POLICY = {
  active: {
    operational: true,
    executable: true,
    discoverable: true,
    adminVisibleByDefault: true,
  },
  draining: {
    operational: true,
    executable: false,
    discoverable: true,
    adminVisibleByDefault: true,
  },
  dormant: {
    operational: false,
    executable: false,
    discoverable: false,
    adminVisibleByDefault: true,
  },
  disabled: {
    operational: false,
    executable: false,
    discoverable: false,
    adminVisibleByDefault: false,
  },
} satisfies Record<MaxBotLifecycleState, MaxBotLifecyclePolicy>;

export function isOperationalBotState(state: MaxBotLifecycleState): boolean {
  return MAX_BOT_LIFECYCLE_POLICY[state].operational;
}

export function canExecuteActionsForBotState(state: MaxBotLifecycleState): boolean {
  return MAX_BOT_LIFECYCLE_POLICY[state].executable;
}

export function canDiscoverChatsForBotState(state: MaxBotLifecycleState): boolean {
  return MAX_BOT_LIFECYCLE_POLICY[state].discoverable;
}

export function isAdminVisibleByDefaultForBotState(state: MaxBotLifecycleState): boolean {
  return MAX_BOT_LIFECYCLE_POLICY[state].adminVisibleByDefault;
}

export function createBotLifecycleStats(
  bots: readonly BotLifecycleStatsInput[],
): BotOwnershipLifecycleStats {
  const stats: BotOwnershipLifecycleStats = {
    configured: bots.length,
    adminVisible: 0,
    active: 0,
    dormant: 0,
    draining: 0,
    disabled: 0,
  };

  for (const bot of bots) {
    stats[bot.state] += 1;
    if (bot.visibleInAdmin ?? isAdminVisibleByDefaultForBotState(bot.state)) {
      stats.adminVisible += 1;
    }
  }

  return stats;
}
