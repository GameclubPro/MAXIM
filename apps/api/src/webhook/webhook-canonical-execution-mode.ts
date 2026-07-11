import { createHash } from 'node:crypto';

export const WEBHOOK_CANONICAL_EXECUTION_MODES = ['off', 'shadow', 'canary', 'on'] as const;

export type WebhookCanonicalExecutionMode = (typeof WEBHOOK_CANONICAL_EXECUTION_MODES)[number];

export function normalizeWebhookCanonicalExecutionMode(
  value: unknown,
): WebhookCanonicalExecutionMode {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return WEBHOOK_CANONICAL_EXECUTION_MODES.includes(normalized as WebhookCanonicalExecutionMode)
    ? (normalized as WebhookCanonicalExecutionMode)
    : 'shadow';
}

export function normalizeWebhookCanonicalCanaryPercent(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.trunc(parsed))) : 1;
}

export function shouldEnforceCanonicalWebhookExecution(params: {
  mode: WebhookCanonicalExecutionMode;
  canaryPercent: number;
  semanticKey: string;
}): boolean {
  if (params.mode === 'on') {
    return true;
  }
  if (params.mode !== 'canary' || params.canaryPercent <= 0) {
    return false;
  }
  if (params.canaryPercent >= 100) {
    return true;
  }

  const bucket =
    Number.parseInt(createHash('sha256').update(params.semanticKey).digest('hex').slice(0, 8), 16) %
    100;
  return bucket < params.canaryPercent;
}
