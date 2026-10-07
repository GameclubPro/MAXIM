import { describeWebhookExecutionFailure } from './webhook-execution-diagnostic';

describe('webhook execution diagnostics', () => {
  it('retains HTTP and source evidence without private error data', () => {
    const error = Object.assign(new Error('secret message and token'), {
      response: { status: 404, data: { token: 'secret' } },
      stack:
        'secret\n at x (/app/moderation/moderation.service.legacy.js:123:45)\n' +
        ' at y (/app/moderation/webhook-canonical-execution.service.ts:67:8)',
    });
    const result = describeWebhookExecutionFailure(error);
    expect(result.httpStatus).toBe(404);
    expect(result.locations).toEqual({
      handler: { format: 'js', line: 123, column: 45 },
      canonical: { format: 'ts', line: 67, column: 8 },
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|token|\/app|message/u);
  });

  it('ignores arbitrary paths and source locations beyond the bounded stack', () => {
    const error = new TypeError('secret');
    error.stack = `/private/secret.js:12:34\n${'x'.repeat(16_384)}\n at x (/moderation/moderation.service.legacy.js:1:2)`;
    expect(describeWebhookExecutionFailure(error)).toMatchObject({
      errorKind: 'type_error',
      locations: {},
    });
  });

  it('tolerates hostile getters without replacing the original exception', () => {
    const error = Object.defineProperty(new Error('secret'), 'stack', {
      get() {
        throw new Error('secret getter');
      },
    });
    expect(describeWebhookExecutionFailure(error)).toMatchObject({ locations: {} });
    expect(JSON.stringify(describeWebhookExecutionFailure(error))).not.toContain('secret');
  });

  it('classifies HTTP routes and known stages without retaining request configuration', () => {
    const error = Object.assign(new Error('secret'), {
      config: {
        method: 'delete',
        url: '/messages/private-id?token=secret',
        headers: { Authorization: 'secret' },
      },
    });
    const result = describeWebhookExecutionFailure(error, 'violation-delete');
    expect(result).toMatchObject({
      requestOperation: 'delete_messages',
      requestTarget: 'single',
      hotPathStage: 'violation-delete',
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|private-id|Authorization/u);
    expect(describeWebhookExecutionFailure(error, 'private-id').hotPathStage).toBe('unknown');
    error.config.url = '/private-id/secret';
    expect(describeWebhookExecutionFailure(error).requestOperation).toBe('unknown');
  });

  it('distinguishes collection lookup failures from exact lookups without identifiers', () => {
    for (const [url, requestTarget] of [
      ['/messages?message_ids=private-id', 'collection'],
      ['/messages/private-id?token=secret', 'single'],
    ]) {
      const result = describeWebhookExecutionFailure({
        config: { method: 'get', url },
        response: { status: 404, data: { error: { code: 'message.not.found', secret: 'secret' } } },
      });
      expect(result).toMatchObject({
        requestOperation: 'get_messages',
        requestTarget,
        maxFailureCode: 'message_not_found',
      });
      expect(JSON.stringify(result)).not.toMatch(/private-id|secret|message_ids/u);
    }
  });

  it.each([
    ['required_subscription_no_longer_authorized', 'subscription_authority_rejected'],
    ['Required subscription source no longer actionable', 'subscription_source_unavailable'],
    ['Required subscription fresh membership unavailable', 'subscription_membership_unavailable'],
    ['Required subscription author access unavailable', 'subscription_author_unavailable'],
    ['Required subscription execution guard unavailable', 'subscription_guard_unavailable'],
  ])('retains only the known reason %s', (message, failureReason) => {
    expect(describeWebhookExecutionFailure(new Error(message)).failureReason).toBe(failureReason);
    expect(describeWebhookExecutionFailure({ code: message }).failureReason).toBe(failureReason);
    const result = describeWebhookExecutionFailure(new Error(`${message}: private-id`));
    expect(result.failureReason).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain('private-id');
  });

  it('ignores unknown upstream codes, malformed bodies and hostile response getters', () => {
    for (const data of [
      { code: 'private-id', message: 'secret' },
      [{ code: 'message.not.found' }],
    ]) {
      expect(describeWebhookExecutionFailure({ response: { data } }).maxFailureCode).toBe(
        'unknown',
      );
    }
    const error = Object.defineProperty(new Error('private-id'), 'response', {
      get() {
        throw new Error('secret');
      },
    });
    expect(() => describeWebhookExecutionFailure(error)).not.toThrow();
    expect(JSON.stringify(describeWebhookExecutionFailure(error))).not.toMatch(
      /private-id|secret/u,
    );
  });
});
