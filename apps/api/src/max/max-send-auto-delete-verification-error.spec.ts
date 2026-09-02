import {
  buildMaxSendAutoDeleteVerificationLedgerErrorCode,
  buildMaxSendAutoDeleteVerificationLedgerErrorMessage,
  classifyMaxSendAutoDeleteVerificationCause,
  createMaxSendAutoDeleteVerificationError,
  MAX_SEND_AUTO_DELETE_VERIFICATION_ERROR_MESSAGE,
  MAX_SEND_AUTO_DELETE_VERIFICATION_UNKNOWN_ERROR_CODE,
  readMaxSendAutoDeleteVerificationDiagnostic,
} from './max-send-auto-delete-verification-error';

describe('MAX send-side auto-delete verification diagnostics', () => {
  it.each([
    [
      'access-masked 404',
      { response: { status: 404, data: { code: 'message.not.found' } } },
      { kind: 'access_ambiguous', statusCode: 404, errorCode: 'message.not.found' },
    ],
    [
      'external rate limit',
      { response: { status: 429, data: { code: 'too.many.requests' } } },
      { kind: 'rate_limit', statusCode: 429, errorCode: 'too.many.requests' },
    ],
    [
      'upstream failure',
      { response: { status: 502, data: { code: 'server.failure' } } },
      { kind: 'upstream_5xx', statusCode: 502, errorCode: 'server.failure' },
    ],
    [
      'timeout',
      { code: 'ECONNABORTED' },
      { kind: 'timeout', statusCode: null, errorCode: 'econnaborted' },
    ],
    [
      'transport failure',
      { code: 'ECONNRESET' },
      { kind: 'transport', statusCode: null, errorCode: 'econnreset' },
    ],
    [
      'open circuit',
      { code: 'MAX_API_CIRCUIT_OPEN' },
      { kind: 'circuit_open', statusCode: null, errorCode: 'max_api_circuit_open' },
    ],
  ] as const)('classifies %s without retaining raw failure data', (_label, cause, expected) => {
    expect(classifyMaxSendAutoDeleteVerificationCause(cause)).toEqual(expected);
  });

  it('drops arbitrary response codes, messages, URLs, and identifiers', () => {
    const diagnostic = classifyMaxSendAutoDeleteVerificationCause({
      message: 'secret-token chat-123 message-456',
      code: 'private-user-789',
      config: {
        url: 'https://platform-api.max.ru/messages/private-message-456?token=secret-token',
      },
    });

    expect(diagnostic).toEqual({ kind: 'unknown', statusCode: null, errorCode: null });
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /secret-token|chat-123|message-456|private-user-789|platform-api/iu,
    );
  });

  it('wraps a cause with a validated diagnostic and redacted stable message', () => {
    const cause = {
      message: 'request failed for chat-123 and message-456',
      response: { status: 503, data: { code: 'server.failure' } },
    };
    const error = createMaxSendAutoDeleteVerificationError(cause);
    const diagnostic = readMaxSendAutoDeleteVerificationDiagnostic(error);

    expect(error).toMatchObject({
      name: 'MaxSendAutoDeleteVerificationError',
      message: MAX_SEND_AUTO_DELETE_VERIFICATION_ERROR_MESSAGE,
      code: MAX_SEND_AUTO_DELETE_VERIFICATION_UNKNOWN_ERROR_CODE,
      cause,
    });
    expect(diagnostic).toEqual({
      kind: 'upstream_5xx',
      statusCode: 503,
      errorCode: 'server.failure',
    });
    expect(error.message).not.toMatch(/chat-123|message-456/iu);
    expect(buildMaxSendAutoDeleteVerificationLedgerErrorCode(diagnostic!)).toBe(
      'send_auto_delete_exact_verification_upstream_5xx',
    );
    expect(buildMaxSendAutoDeleteVerificationLedgerErrorMessage(diagnostic!)).toBe(
      'Send-side auto-delete exact presence verification failed (upstream_5xx)',
    );
  });

  it('rejects forged diagnostics even when every field is allowlisted', () => {
    expect(
      readMaxSendAutoDeleteVerificationDiagnostic({
        code: MAX_SEND_AUTO_DELETE_VERIFICATION_UNKNOWN_ERROR_CODE,
        maxSendAutoDeleteVerificationDiagnostic: {
          kind: 'transport',
          statusCode: null,
          errorCode: 'econnreset',
        },
      }),
    ).toBeNull();
  });

  it('rejects unbounded diagnostics', () => {
    expect(
      readMaxSendAutoDeleteVerificationDiagnostic({
        code: MAX_SEND_AUTO_DELETE_VERIFICATION_UNKNOWN_ERROR_CODE,
        maxSendAutoDeleteVerificationDiagnostic: {
          kind: 'transport',
          statusCode: null,
          errorCode: 'private-user-789',
        },
      }),
    ).toBeNull();
  });
});
