import {
  parseDuplicateDiagnosticsRecoveryOptions,
  duplicateDiagnosticsRecoveryQuery,
} from './recover-duplicate-diagnostics';

const now = Date.now();
const args = ['--chat-id', 'exact-chat', '--until', new Date(now).toISOString()];
describe('bounded observer-only duplicate diagnostics recovery', () => {
  it('requires an explicit exact chat, snapshot and reviewed preview before apply', () => {
    expect(parseDuplicateDiagnosticsRecoveryOptions(args, now)).toMatchObject({
      chatId: 'exact-chat',
      apply: false,
      limit: 100,
    });
    for (const extra of [
      ['--apply'],
      ['--limit', '101'],
      ['--limit', '0'],
      ['--all-enabled-chats'],
    ])
      expect(() => parseDuplicateDiagnosticsRecoveryOptions([...args, ...extra], now)).toThrow();
    expect(() =>
      parseDuplicateDiagnosticsRecoveryOptions(['--until', new Date(now).toISOString()], now),
    ).toThrow();
    expect(() => parseDuplicateDiagnosticsRecoveryOptions(args, now + 86400001)).toThrow();
    const sql = duplicateDiagnosticsRecoveryQuery(
      parseDuplicateDiagnosticsRecoveryOptions(args, now),
    );
    expect(sql.sql).toContain('WHERE chat_id = ? AND status = statuses.status');
    expect(sql.sql).toContain('WHERE intent_id = candidates.id');
    expect(sql.sql).not.toMatch(/webhook_events|metadata|masked_excerpt/u);
    expect(sql.values).toContain(101);
  });
  it('bounds encoded cursors before parsing and compares fractional UTC instants', () => {
    expect(() =>
      parseDuplicateDiagnosticsRecoveryOptions([...args, '--cursor', 'x'.repeat(1025)], now),
    ).toThrow('too long');
    const until = '2026-10-05T12:00:00.000Z';
    const cursor = Buffer.from(
      JSON.stringify({ chatId: 'exact-chat', until, at: '2026-10-05T12:00:00Z', id: 'last' }),
    ).toString('base64url');
    expect(
      parseDuplicateDiagnosticsRecoveryOptions(
        ['--chat-id', 'exact-chat', '--until', until, '--cursor', cursor],
        Date.parse(until),
      ),
    ).toMatchObject({ cursor: { at: '2026-10-05T12:00:00Z' } });
  });
});
