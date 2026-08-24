import {
  channelSuggestionDeliverySummarySchema,
  type ChannelSuggestionDeliverySummary,
} from '@maxim/contracts';

type DeliveryTargetEvidence = {
  sent: boolean;
  pending: boolean;
  unreachable: boolean;
  uncertain: boolean;
};

const DELIVERY_JOB_FAILURE_TARGET = 'delivery_job';

export function buildChannelSuggestionDeliverySummary(
  payload: Record<string, unknown>,
): ChannelSuggestionDeliverySummary {
  const snapshot = channelSuggestionDeliverySummarySchema.safeParse(payload.suggestionDelivery);
  if (snapshot.success) {
    return snapshot.data;
  }

  const targets = new Map<string, DeliveryTargetEvidence>();
  let hasUnscopedFailure = false;

  for (const [index, value] of readRows(payload.deliveries).entries()) {
    const adminUserId = readNonEmptyString(value.adminUserId);
    markTarget(targets, adminUserId ? `admin:${adminUserId}` : `delivery:${index}`, 'sent');
  }

  const deliveredToUserIds = Array.isArray(payload.deliveredToUserIds)
    ? payload.deliveredToUserIds
    : [];
  for (const [index, value] of deliveredToUserIds.entries()) {
    const adminUserId = readNonEmptyString(value);
    if (adminUserId) {
      markTarget(targets, `admin:${adminUserId}`, 'sent');
    } else if (value !== null && value !== undefined) {
      markTarget(targets, `legacy-delivered:${index}`, 'sent');
    }
  }

  const deliveredToUserId = readNonEmptyString(payload.deliveredToUserId);
  if (deliveredToUserId) {
    markTarget(targets, `admin:${deliveredToUserId}`, 'sent');
  }

  const failures = readRows(payload.deliveryFailures);
  for (const [index, value] of failures.entries()) {
    const adminUserId = readNonEmptyString(value.adminUserId);
    if (adminUserId === DELIVERY_JOB_FAILURE_TARGET) {
      hasUnscopedFailure = true;
      continue;
    }

    const targetKey = adminUserId ? `admin:${adminUserId}` : `failure:${index}`;
    if (value.recoverable === true) {
      markTarget(targets, targetKey, 'pending');
    } else if (isUnavailablePrivateDialogFailure(value)) {
      markTarget(targets, targetKey, 'unreachable');
    } else {
      markTarget(targets, targetKey, 'uncertain');
    }
  }

  if (payload.delivered === true && ![...targets.values()].some((target) => target.sent)) {
    markTarget(targets, 'legacy-delivered', 'sent');
  }

  const evidence = [...targets.values()];
  const deliveredCount = evidence.filter((target) => target.sent).length;
  const pendingCount = evidence.filter(
    (target) => !target.sent && !target.uncertain && target.pending,
  ).length;
  const unreachableCount = evidence.filter(
    (target) => !target.sent && !target.uncertain && !target.pending && target.unreachable,
  ).length;
  const targetCount = evidence.length;
  const attempted = Boolean(readNonEmptyString(payload.deliveryAttemptedAt)) || failures.length > 0;

  let state: ChannelSuggestionDeliverySummary['state'];
  if (deliveredCount > 0) {
    state = deliveredCount === targetCount ? 'delivered' : 'partially_delivered';
  } else if (!attempted || pendingCount > 0) {
    state = 'queued';
  } else if (!hasUnscopedFailure && (targetCount === 0 || unreachableCount === targetCount)) {
    state = 'no_reachable_editor';
  } else {
    state = 'uncertain';
  }

  return {
    state,
    deliveredCount,
    targetCount,
    pendingCount,
    unreachableCount,
  };
}

function readRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is Record<string, unknown> =>
    Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)),
  );
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isUnavailablePrivateDialogFailure(value: Record<string, unknown>): boolean {
  if (value.terminal !== true) {
    return false;
  }

  const status =
    typeof value.status === 'number'
      ? value.status
      : typeof value.status === 'string' && /^\d{3}$/u.test(value.status.trim())
        ? Number.parseInt(value.status, 10)
        : null;
  const code = readNonEmptyString(value.code)?.toLowerCase() ?? '';
  const explicitUnavailable =
    code === 'suggestion.delivery.no_reachable_dialog' ||
    code === 'suggestion.delivery.dialog_unavailable' ||
    code === 'suggestion.delivery.editor_removed';
  return (
    explicitUnavailable ||
    (!code.startsWith('suggestion.delivery.') &&
      (status === 403 ||
        status === 404 ||
        code === 'access.denied' ||
        code === 'dialog.not.found' ||
        code === 'chat.not.found' ||
        code === 'chat.denied'))
  );
}

function markTarget(
  targets: Map<string, DeliveryTargetEvidence>,
  key: string,
  evidence: keyof DeliveryTargetEvidence,
): void {
  const target = targets.get(key) ?? {
    sent: false,
    pending: false,
    unreachable: false,
    uncertain: false,
  };
  target[evidence] = true;
  targets.set(key, target);
}
