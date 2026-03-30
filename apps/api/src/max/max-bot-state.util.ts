import type { MaxBotLifecycleState } from './max-bot-config.util';

export function isOperationalBotState(state: MaxBotLifecycleState): boolean {
  return state === 'active' || state === 'draining';
}

export function canExecuteActionsForBotState(state: MaxBotLifecycleState): boolean {
  return state === 'active';
}

export function canDiscoverChatsForBotState(state: MaxBotLifecycleState): boolean {
  return state === 'active' || state === 'draining';
}
