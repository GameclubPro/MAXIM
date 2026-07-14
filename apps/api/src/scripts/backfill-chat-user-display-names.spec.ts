import {
  buildChatUserDisplayNameBackfillStateSourceKind,
  parseChatUserDisplayNameBackfillOptions,
} from './backfill-chat-user-display-names';

describe('parseChatUserDisplayNameBackfillOptions', () => {
  it('uses bounded, non-mutating defaults', () => {
    expect(parseChatUserDisplayNameBackfillOptions([])).toEqual({
      source: 'all',
      chatId: null,
      chatLimit: 10,
      batchSize: 250,
      sinceDays: 180,
      dryRun: false,
      json: false,
      help: false,
    });
  });

  it('limits a targeted repair to one chat and accepts dry-run mode', () => {
    expect(
      parseChatUserDisplayNameBackfillOptions([
        '--source',
        'membership',
        '--chat-id',
        'chat-1',
        '--batch-size',
        '500',
        '--dry-run',
        '--json',
      ]),
    ).toEqual({
      source: 'membership',
      chatId: 'chat-1',
      chatLimit: 1,
      batchSize: 500,
      sinceDays: 180,
      dryRun: true,
      json: true,
      help: false,
    });
  });

  it('rejects unbounded or invalid options', () => {
    expect(() => parseChatUserDisplayNameBackfillOptions(['--batch-size', '1001'])).toThrow(
      /batch-size/u,
    );
    expect(() => parseChatUserDisplayNameBackfillOptions(['--source', 'webhook'])).toThrow(
      /source/u,
    );
    expect(() => parseChatUserDisplayNameBackfillOptions(['--unknown'])).toThrow(/Unknown/u);
  });

  it('keeps backfill cursor state separate for each requested history range', () => {
    expect(buildChatUserDisplayNameBackfillStateSourceKind('moderation', 7)).toBe(
      'chat_user_display_name:moderation:v3:7d',
    );
    expect(buildChatUserDisplayNameBackfillStateSourceKind('moderation', 180)).toBe(
      'chat_user_display_name:moderation:v3:180d',
    );
  });
});
