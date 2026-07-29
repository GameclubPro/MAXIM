import { UnrecoverableError } from 'bullmq';
import type { MaxActionJob } from './max-client.service';

export const MAX_ACTION_NO_EXECUTABLE_ROUTE_ERROR_CODE = 'MAX_ACTION_NO_EXECUTABLE_ROUTE' as const;
export const MAX_ACTION_ROUTE_QUARANTINED_ERROR_CODE = 'MAX_ACTION_ROUTE_QUARANTINED' as const;

export function buildMaxActionNoExecutableRouteMessage(
  actionType: MaxActionJob['actionType'],
  chatId: string,
): string {
  return `MAX ${actionType} has no executable routed bot candidate for chat ${chatId}`;
}

export function buildMaxActionRouteQuarantinedMessage(
  actionType: MaxActionJob['actionType'],
  chatId: string,
): string {
  return `MAX ${actionType} route is quarantined for chat ${chatId}`;
}

export class MaxActionNoExecutableRouteError extends UnrecoverableError {
  readonly code = MAX_ACTION_NO_EXECUTABLE_ROUTE_ERROR_CODE;
  readonly preDispatch = true;

  constructor(
    readonly actionType: MaxActionJob['actionType'],
    readonly chatId: string,
  ) {
    super(buildMaxActionNoExecutableRouteMessage(actionType, chatId));
    this.name = 'MaxActionNoExecutableRouteError';
  }
}

export class MaxActionRouteQuarantinedError extends Error {
  readonly code = MAX_ACTION_ROUTE_QUARANTINED_ERROR_CODE;
  readonly preDispatch = true;

  constructor(
    readonly actionType: MaxActionJob['actionType'],
    readonly chatId: string,
    readonly retryAt: Date,
    readonly quarantinedCandidateBotIds: readonly string[],
  ) {
    super(buildMaxActionRouteQuarantinedMessage(actionType, chatId));
    this.name = 'MaxActionRouteQuarantinedError';
  }
}

export function isMaxActionNoExecutableRouteError(
  error: unknown,
): error is MaxActionNoExecutableRouteError {
  return (
    error instanceof MaxActionNoExecutableRouteError ||
    (Boolean(error) &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === MAX_ACTION_NO_EXECUTABLE_ROUTE_ERROR_CODE &&
      (error as { preDispatch?: unknown }).preDispatch === true)
  );
}

export function isMaxActionRouteQuarantinedError(
  error: unknown,
): error is MaxActionRouteQuarantinedError {
  return (
    error instanceof MaxActionRouteQuarantinedError ||
    (Boolean(error) &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === MAX_ACTION_ROUTE_QUARANTINED_ERROR_CODE &&
      (error as { preDispatch?: unknown }).preDispatch === true &&
      (error as { retryAt?: unknown }).retryAt instanceof Date)
  );
}
