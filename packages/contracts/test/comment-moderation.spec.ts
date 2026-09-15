import { describe, expect, it } from 'vitest';
import { updateCommentRestrictionRequestSchema as schema } from '../src/channel-dialog.js';

const base = { token: 'signed-comment-token', expectedRevision: 0 };
describe('comment restrictions', () => {
  it.each([3600, 86400, 604800])('accepts mute duration %s', (durationSeconds) => {
    expect(schema.parse({ ...base, action: 'MUTE', durationSeconds }).reason).toBe('');
  });
  it.each([
    { action: 'MUTE' },
    { action: 'MUTE', durationSeconds: 0 },
    { action: 'MUTE', durationSeconds: 1.5 },
    { action: 'MUTE', durationSeconds: 31536000 },
    { action: 'BAN', durationSeconds: 3600 },
    { action: 'RELEASE', durationSeconds: 3600 },
    { action: 'BAN', expectedRevision: -1 },
    { action: 'BAN', reason: 'x'.repeat(301) },
    { action: 'BAN', profile: 'publisher' },
    { action: 'BAN', token: '' },
    { action: 'BAN', sourceMessageId: '' },
  ])('rejects invalid command %j', (input) => {
    expect(schema.safeParse({ ...base, ...input }).success).toBe(false);
  });
  it('requires a revision and strips no unrecognized scope override', () => {
    expect(schema.safeParse({ token: base.token, action: 'BAN' }).success).toBe(false);
    expect(schema.parse({ ...base, action: 'RELEASE' }).action).toBe('RELEASE');
  });
});
