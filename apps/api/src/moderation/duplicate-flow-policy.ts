import type { ChatSettings } from '../prisma/prisma-client';
import type {
  DuplicateAction,
  DuplicateDecision,
  DuplicateFingerprintType,
  DuplicateHit,
} from './rule-engine.contract';

export type DuplicateReactionStage = {
  action: DuplicateAction | null;
};

export type DuplicateFlowConfig = {
  allowedCount: number;
  windowSec: number;
  reactions: DuplicateReactionStage[];
};

export function resolveDuplicateFlowConfig(settings: ChatSettings): DuplicateFlowConfig {
  const firstThreshold = settings.duplicateWarnEnabled
    ? settings.duplicateWarnMaxCount
    : settings.duplicateMuteEnabled
      ? settings.duplicateMuteMaxCount
      : settings.duplicateBanEnabled
        ? settings.duplicateBanMaxCount
        : settings.duplicateWarnMaxCount;
  const windowSec = settings.duplicateWarnEnabled
    ? settings.duplicateWarnWindowSec
    : settings.duplicateMuteEnabled
      ? settings.duplicateMuteWindowSec
      : settings.duplicateBanEnabled
        ? settings.duplicateBanWindowSec
        : settings.duplicateWarnWindowSec;
  const reactions: DuplicateReactionStage[] = [];
  if (settings.duplicateBotMessageEnabled) {
    reactions.push({ action: null });
  }
  if (settings.duplicateWarnEnabled) {
    reactions.push({ action: 'WARN' });
  }
  if (settings.duplicateMuteEnabled) {
    reactions.push({ action: 'MUTE' });
  }
  if (settings.duplicateBanEnabled) {
    reactions.push({ action: 'BAN' });
  }

  return {
    allowedCount: Math.max(0, firstThreshold - (settings.duplicateBotMessageEnabled ? 2 : 1)),
    windowSec,
    reactions,
  };
}

export function resolveDuplicateFlowOutcome(params: {
  settings: ChatSettings;
  repeatCount: number;
  hash: string;
  fingerprintType: DuplicateFingerprintType;
  metadata?: Record<string, unknown>;
}): { hit?: DuplicateHit; decision?: DuplicateDecision } {
  const flow = resolveDuplicateFlowConfig(params.settings);
  if (params.repeatCount <= flow.allowedCount || flow.reactions.length === 0) {
    return {};
  }

  const hit: DuplicateHit = {
    count: params.repeatCount,
    windowSec: flow.windowSec,
    hash: params.hash,
    fingerprintType: params.fingerprintType,
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
  const reactionIndex = Math.min(
    flow.reactions.length - 1,
    params.repeatCount - flow.allowedCount - 1,
  );
  const action = flow.reactions[reactionIndex]?.action ?? null;
  if (!action) {
    return { hit };
  }

  return {
    hit,
    decision: {
      action,
      count: params.repeatCount,
      threshold: flow.allowedCount + reactionIndex + 1,
      windowSec: flow.windowSec,
      hash: params.hash,
      fingerprintType: params.fingerprintType,
      nextAction: resolveNextAction(flow.reactions, reactionIndex),
      ...(params.metadata ? { metadata: params.metadata } : {}),
    },
  };
}

export function duplicateFlowConfigsEqual(
  left: DuplicateFlowConfig,
  right: DuplicateFlowConfig,
): boolean {
  return (
    left.allowedCount === right.allowedCount &&
    left.windowSec === right.windowSec &&
    left.reactions.length === right.reactions.length &&
    left.reactions.every((stage, index) => stage.action === right.reactions[index]?.action)
  );
}

function resolveNextAction(
  reactions: readonly DuplicateReactionStage[],
  currentIndex: number,
): DuplicateAction | null {
  for (let index = currentIndex + 1; index < reactions.length; index += 1) {
    const nextAction = reactions[index]?.action;
    if (nextAction) {
      return nextAction;
    }
  }
  return null;
}
