import { WebhookParser } from '../../webhook/webhook.parser';
import { ReportSubmissionService } from './report-submission.service';

describe('paused report admission', () => {
  it('recognizes the configured command without bypassing the global admission ceiling', async () => {
    const update = new WebhookParser().parse({
      update_type: 'message_created',
      timestamp: Date.now(),
      message: {
        sender: { user_id: 'reporter', is_bot: false },
        recipient: { chat_id: '-1', chat_type: 'chat' },
        timestamp: Date.now(),
        body: { mid: 'command', text: ' Жалоба ' },
        link: { type: 'reply', chat_id: '-1', message: { mid: 'target' } },
      },
    });
    update.botId = 'bot-a';
    const state = { enabled: jest.fn().mockReturnValue(false), source: jest.fn() };
    const max = { sendMessage: jest.fn() };
    const deletes = { ensureIntent: jest.fn() };
    const service = new ReportSubmissionService(
      state as never,
      {} as never,
      max as never,
      deletes as never,
      { setStringIfAbsentWithTtl: jest.fn().mockResolvedValue(true) } as never,
    );
    const settings = { reportsEnabled: true, reportsAliases: [] };
    expect(service.isCommand(update, settings)).toBe(true);
    expect(await service.handle(update, settings)).toBe(true);
    expect(state.source).not.toHaveBeenCalled();
    expect(deletes.ensureIntent).not.toHaveBeenCalled();
    expect(max.sendMessage).toHaveBeenCalledWith(
      '-1',
      'Приём жалоб приостановлен. Жалоба не учтена.',
      expect.anything(),
      expect.anything(),
    );
    expect(service.isCommand(update, { ...settings, reportsEnabled: false })).toBe(false);
  });
});
