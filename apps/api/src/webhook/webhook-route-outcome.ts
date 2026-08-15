export const MAX_WEBHOOK_ROUTE_OUTCOMES = [
  'accepted',
  'authentication_rejected',
  'admission_rejected',
  'invalid_json',
  'invalid_payload',
  'payload_too_large',
  'timed_out',
  'failed',
] as const;

export type MaxWebhookRouteOutcome = (typeof MAX_WEBHOOK_ROUTE_OUTCOMES)[number];

export type MaxWebhookRouteOutcomeMetric = {
  botId: string | null;
  outcome: MaxWebhookRouteOutcome;
};
