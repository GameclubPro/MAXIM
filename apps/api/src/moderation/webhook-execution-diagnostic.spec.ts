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
      hotPathStage: 'violation-delete',
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|private-id|Authorization/u);
    expect(describeWebhookExecutionFailure(error, 'private-id').hotPathStage).toBe('unknown');
    error.config.url = '/private-id/secret';
    expect(describeWebhookExecutionFailure(error).requestOperation).toBe('unknown');
  });
});
