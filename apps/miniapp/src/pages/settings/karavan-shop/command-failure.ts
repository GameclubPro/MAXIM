import { ApiRequestError } from '../../../lib/api-request-error';

export function shopMutationFailureKind(
  error: unknown,
): 'validation' | 'refresh' | 'forbidden' | 'unknown' {
  if (!(error instanceof ApiRequestError)) return 'unknown';
  if (error.code === 'KARAVAN_COMMAND_UNKNOWN') return 'unknown';
  if (error.code === 'KARAVAN_COMMAND_REJECTED') return 'refresh';
  if (error.status >= 500) return 'unknown';
  if (error.status === 401 || error.status === 403 || error.code === 'MARKETPLACE_BINDING_CHANGED')
    return 'forbidden';
  if (
    error.status === 404 ||
    error.status === 409 ||
    error.code === 'MARKETPLACE_RULES_DATE_INVALID'
  )
    return 'refresh';
  if (error.status === 400 || error.status === 422) return 'validation';
  return 'unknown';
}

export function isDefiniteFirstShopRejection(error: unknown, dispatchCount: number): boolean {
  if (dispatchCount !== 1 || !(error instanceof ApiRequestError)) return false;
  if (error.code === 'KARAVAN_COMMAND_UNKNOWN' || error.code === 'MARKETPLACE_COMMAND_CONFLICT')
    return false;
  if (error.code === 'KARAVAN_COMMAND_REJECTED') return true;
  if (![400, 401, 403, 404, 409, 422].includes(error.status)) return false;
  if (!error.code) return error.status === 400 || error.status === 422;
  return [
    'MARKETPLACE_REVISION_CONFLICT',
    'MARKETPLACE_BINDING_CHANGED',
    'MARKETPLACE_IMPACT_CHANGED',
    'MARKETPLACE_SELF_REVIEW',
    'MARKETPLACE_RULES_NOTICE_REQUIRED',
    'MARKETPLACE_RULES_ALREADY_SCHEDULED',
    'MARKETPLACE_RULES_DATE_INVALID',
    'MARKETPLACE_FORBIDDEN',
    'MARKETPLACE_CATEGORIES_INVALID',
    'MARKETPLACE_PIN_UNAVAILABLE',
    'MARKETPLACE_IMAGE_INVALID',
    'MARKETPLACE_CONTENT_NOT_FOUND',
  ].includes(error.code);
}
