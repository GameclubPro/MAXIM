import { createAdminSuggestionDeliveryRuntimeContext } from './admin-suggestion-delivery-runtime-context';

describe('AdminSuggestionDeliveryRuntimeContext', () => {
  it('exposes queue and logger through typed accessors', () => {
    const target = {
      logger: { warn: jest.fn() },
      adminSuggestionDeliveryQueue: { add: jest.fn() },
      processChannelSuggestionDeliveryJobWithinTimeout: jest.fn(),
    };
    const context = createAdminSuggestionDeliveryRuntimeContext(target);

    expect(context.logger).toBe(target.logger);
    expect(context.adminSuggestionDeliveryQueue).toBe(target.adminSuggestionDeliveryQueue);
  });

  it('delegates suggestion delivery processing without losing the legacy target context', async () => {
    const target = {
      prefix: 'legacy',
      logger: { warn: jest.fn() },
      processChannelSuggestionDeliveryJobWithinTimeout(auditLogId: string): Promise<void> {
        this.logger.warn(`${this.prefix}:${auditLogId}`);
        return Promise.resolve();
      },
    };
    const context = createAdminSuggestionDeliveryRuntimeContext(target);

    await context.processChannelSuggestionDeliveryJobWithinTimeout('suggestion-1');

    expect(target.logger.warn).toHaveBeenCalledWith('legacy:suggestion-1');
  });
});
