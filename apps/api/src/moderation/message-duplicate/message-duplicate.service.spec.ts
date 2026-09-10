import { MessageDuplicateService } from './message-duplicate.service';
import { duplicateSettings, duplicateUpdate } from './message-duplicate-test-fixtures';

describe('message duplicate main-path admission', () => {
  function setup() {
    const policy = { resolve: jest.fn().mockResolvedValue({ mode: 'delete_only', revision: 1 }) };
    const history = { observe: jest.fn().mockResolvedValue({ hit: {}, binding: {} }) };
    const enforcement = { enqueue: jest.fn() };
    const queue = { enqueue: jest.fn() };
    const service = new MessageDuplicateService(
      policy as never,
      history as never,
      enforcement as never,
      queue as never,
    );
    const update = duplicateUpdate();
    const params = {
      update,
      webhookEventId: 'receipt',
      eventTimestampMs: Date.parse(update.message!.createdAt),
      settings: duplicateSettings(),
      botId: 'bot',
      actionEligible: true,
      track: true,
    };
    return { service, params, policy, history, enforcement, queue };
  }
  it('admits short messages inline and never silently acknowledges state failures', async () => {
    const s = setup();
    await s.service.observe(s.params);
    expect(s.enforcement.enqueue).toHaveBeenCalledTimes(1);
    expect(s.queue.enqueue).not.toHaveBeenCalled();
    s.history.observe.mockRejectedValue(new Error('state deadline'));
    await expect(s.service.observe(s.params)).rejects.toThrow('state deadline');
  });
  it('uses durable media jobs only for MESSAGE and compares captions inline in TEXT mode', async () => {
    const s = setup();
    s.params.update = duplicateUpdate('m2', s.params.eventTimestampMs, 'caption', [
      { type: 'file', payload: { url: 'https://fd.oneme.ru/file' } },
    ]);
    await s.service.observe(s.params);
    expect(s.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ webhookEventId: 'receipt', actionEligible: true }),
    );
    expect(s.enforcement.enqueue).not.toHaveBeenCalled();
    s.params.settings.duplicateCompareMode = 'TEXT';
    await s.service.observe(s.params);
    expect(s.queue.enqueue).toHaveBeenCalledTimes(1);
    expect(s.enforcement.enqueue).toHaveBeenCalledTimes(1);
  });
  it('observes shadow and competing legacy outcomes without new actions', async () => {
    const s = setup();
    await s.service.observe({ ...s.params, actionEligible: false });
    expect(s.enforcement.enqueue).not.toHaveBeenCalled();
    await s.service.observe({ ...s.params, track: false });
    expect(s.history.observe).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: expect.objectContaining({ complete: false }) }),
    );
    expect(s.enforcement.enqueue).not.toHaveBeenCalled();
    s.policy.resolve.mockResolvedValue({ mode: 'shadow', revision: 1 });
    await s.service.observe(s.params);
    expect(s.enforcement.enqueue).not.toHaveBeenCalled();
  });
  it('does not admit disabled, non-canary, or untrusted ingress-clock observations', async () => {
    const s = setup();
    await s.service.observe({ ...s.params, eventTimestampMs: undefined });
    await s.service.observe({
      ...s.params,
      settings: duplicateSettings({ antiDuplicateEnabled: false }),
    });
    s.policy.resolve.mockResolvedValue({ mode: 'off' });
    await s.service.observe(s.params);
    expect(s.history.observe).not.toHaveBeenCalled();
  });
});
