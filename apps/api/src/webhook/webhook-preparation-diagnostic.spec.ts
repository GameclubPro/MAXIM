import { describeWebhookPreparationFailure } from './webhook-preparation-diagnostic';

describe('webhook preparation diagnostics', () => {
  it('keeps only known codes, HTTP status and the numeric service location', () => {
    const error = Object.assign(new Error('private-message-token'), {
      code: 'P2003',
      response: { status: 503, data: { token: 'private-token' } },
      stack:
        'private-message\n at task (/app/apps/api/dist/apps/api/src/webhook/webhook.service.js:719:42)',
    });
    const diagnostic = describeWebhookPreparationFailure(error);
    expect(diagnostic).toEqual({
      errorKind: 'prisma',
      errorCode: 'P2003',
      httpStatus: 503,
      webhookServiceLocation: { format: 'js', line: 719, column: 42 },
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|\/app\/|token/u);
  });

  it.each([
    null,
    undefined,
    'private-message',
    {
      name: 'private-name',
      code: 'private-token',
      message: 'private-message',
      status: Infinity,
      stack: '/private/path:123:45',
    },
  ])('does not serialize untrusted error fields', (error) => {
    expect(describeWebhookPreparationFailure(error)).toEqual({
      errorKind: 'unknown',
      errorCode: null,
      httpStatus: null,
      webhookServiceLocation: null,
    });
  });

  it('identifies a type error without retaining its message and bounds stack inspection', () => {
    const error = new TypeError('private-message');
    error.stack = `${'x'.repeat(16_384)} /webhook/webhook.service.ts:10:20`;
    expect(describeWebhookPreparationFailure(error)).toEqual({
      errorKind: 'type_error',
      errorCode: null,
      httpStatus: null,
      webhookServiceLocation: null,
    });
  });

  it('never lets an error getter break the committed retry path', () => {
    const error = Object.defineProperty(new Error('private-message'), 'response', {
      get() {
        throw new Error('private-getter-failure');
      },
    });
    expect(describeWebhookPreparationFailure(error)).toEqual({
      errorKind: 'unknown',
      errorCode: null,
      httpStatus: null,
      webhookServiceLocation: null,
    });
  });
});
