export const MAX_ACTION_LEGACY_QUEUE = 'moderation-actions';
export const MAX_ACTION_CRITICAL_QUEUE = 'max-actions-critical';
export const MAX_ACTION_INTERACTIVE_QUEUE = 'max-actions-interactive';
export const MAX_ACTION_BACKGROUND_QUEUE = 'max-actions-background';

export const MAX_ACTION_LANE_QUEUE_NAMES = [
  MAX_ACTION_CRITICAL_QUEUE,
  MAX_ACTION_INTERACTIVE_QUEUE,
  MAX_ACTION_BACKGROUND_QUEUE,
] as const;

export const MAX_ACTION_ALL_QUEUE_NAMES = [
  MAX_ACTION_LEGACY_QUEUE,
  ...MAX_ACTION_LANE_QUEUE_NAMES,
] as const;

export type MaxActionQueueName = (typeof MAX_ACTION_ALL_QUEUE_NAMES)[number];
export type MaxActionLaneQueueName = (typeof MAX_ACTION_LANE_QUEUE_NAMES)[number];
export type MaxActionQueueTrafficClass = 'critical' | 'interactive' | 'background';

export function resolveMaxActionQueueName(input: {
  actionType: string;
  trafficClass?: string | null;
}): MaxActionLaneQueueName {
  switch (input.trafficClass) {
    case 'critical':
      return MAX_ACTION_CRITICAL_QUEUE;
    case 'background':
      return MAX_ACTION_BACKGROUND_QUEUE;
    case 'interactive':
      return MAX_ACTION_INTERACTIVE_QUEUE;
    default:
      return input.actionType === 'SEND_MESSAGE'
        ? MAX_ACTION_INTERACTIVE_QUEUE
        : MAX_ACTION_CRITICAL_QUEUE;
  }
}
