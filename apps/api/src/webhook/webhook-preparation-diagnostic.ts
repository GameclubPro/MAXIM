import { extractHttpStatusCode } from '../common/http-error.util';

const SAFE_ERROR_CODES = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'P2000',
  'P2002',
  'P2003',
  'P2004',
  'P2010',
  'P2011',
  'P2012',
  'P2013',
  'P2019',
  'P2021',
  'P2022',
  'P2024',
  'P2025',
  'P2028',
  'P2034',
  '23502',
  '23503',
  '23505',
  '40001',
  '40P01',
  '57014',
  '53200',
  '53300',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
]);

export function describeWebhookPreparationFailure(error: unknown) {
  try {
    return readPreparationFailure(error);
  } catch {
    return {
      errorKind: 'unknown',
      errorCode: null,
      httpStatus: null,
      webhookServiceLocation: null,
    };
  }
}

function readPreparationFailure(error: unknown) {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : null;
  const code =
    typeof record?.code === 'string' && SAFE_ERROR_CODES.has(record.code) ? record.code : null;
  const status = extractHttpStatusCode(error);
  const httpStatus =
    status !== null && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  // FLAG: Never log an error message, arbitrary name/code, stack, payload or entity identity.
  // Only a known service's numeric source location may survive stack inspection.
  const stack =
    error instanceof Error && typeof error.stack === 'string' ? error.stack.slice(0, 16_384) : '';
  const location = /\/webhook\/webhook\.service\.(js|ts):([0-9]{1,7}):([0-9]{1,5})\b/u.exec(stack);
  return {
    errorKind:
      error instanceof TypeError
        ? 'type_error'
        : code?.startsWith('P')
          ? 'prisma'
          : record?.name === 'PrismaClientValidationError'
            ? 'prisma_validation'
            : httpStatus !== null
              ? 'http'
              : error instanceof Error
                ? 'error'
                : 'unknown',
    errorCode: code,
    httpStatus,
    webhookServiceLocation: location
      ? { format: location[1], line: Number(location[2]), column: Number(location[3]) }
      : null,
  };
}
