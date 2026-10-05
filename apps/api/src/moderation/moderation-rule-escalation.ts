import { SanctionAction } from '../prisma/prisma-client';

type EnabledSanctions = { warnEnabled: boolean; banEnabled: boolean; muteEnabled: boolean };

export function resolveConfiguredRuleEscalation(
  violationCount: number,
  settings: EnabledSanctions & { warnMaxCount: number; muteMaxCount: number; banMaxCount: number },
): Extract<SanctionAction, 'NONE' | 'WARN' | 'MUTE' | 'BAN'> {
  const count = Number.isInteger(violationCount) ? Math.max(1, violationCount) : 1;
  const threshold = (value: number, fallback: number) =>
    Number.isInteger(value) ? Math.min(20, Math.max(1, value)) : fallback;
  for (const [action, enabled, at] of [
    [SanctionAction.BAN, settings.banEnabled, threshold(settings.banMaxCount, 4)],
    [SanctionAction.MUTE, settings.muteEnabled, threshold(settings.muteMaxCount, 3)],
    [SanctionAction.WARN, settings.warnEnabled, threshold(settings.warnMaxCount, 2)],
  ] as const)
    if (enabled && count >= at) return action;
  return SanctionAction.NONE;
}

export function resolveMessageLimitsRuleEscalation(
  violationCount: number,
  settings: EnabledSanctions,
): Extract<SanctionAction, 'NONE' | 'WARN' | 'MUTE' | 'BAN'> {
  const count = Number.isInteger(violationCount) ? Math.max(1, violationCount) : 1;
  if (count >= 4)
    return settings.banEnabled
      ? SanctionAction.BAN
      : settings.muteEnabled
        ? SanctionAction.MUTE
        : settings.warnEnabled
          ? SanctionAction.WARN
          : SanctionAction.NONE;
  if (count === 3)
    return settings.muteEnabled
      ? SanctionAction.MUTE
      : settings.banEnabled
        ? SanctionAction.BAN
        : settings.warnEnabled
          ? SanctionAction.WARN
          : SanctionAction.NONE;
  return count === 2 && settings.warnEnabled ? SanctionAction.WARN : SanctionAction.NONE;
}
