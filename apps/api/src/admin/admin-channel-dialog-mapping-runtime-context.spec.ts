import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as values from './admin-channel-dialog-values';
import { AdminChannelDialogMappingRuntime } from './admin-channel-dialog-mapping-runtime';
import { createAdminChannelDialogMappingRuntimeContext } from './admin-channel-dialog-mapping-runtime-context';

const corpus = JSON.parse(
  readFileSync(join(__dirname, 'admin-channel-dialog-values.baseline.json'), 'utf8'),
) as Array<{ method: keyof typeof values; args: unknown[]; expected: unknown }>;

describe('dialog value compatibility with the captured legacy baseline', () => {
  it.each(corpus.map((sample, index) => ({ ...sample, index })))(
    '$index: $method preserves stored payload interpretation',
    ({ method, args, expected }) => {
      const call = values[method] as (...args: unknown[]) => unknown;
      expect(call(...args)).toEqual(expected);
    },
  );
});

describe('dialog mapping without AdminService', () => {
  it.each([
    ['author', ['admin'], true, false],
    ['admin', ['admin'], false, true],
    ['outsider', ['admin'], false, false],
  ] as const)('keeps edit and delete access for %s', (viewer, admins, isOwn, canDeleteAsAdmin) => {
    const runtime = new AdminChannelDialogMappingRuntime(
      createAdminChannelDialogMappingRuntimeContext(values),
    );
    const result = runtime.mapChannelDialogAuditLog(
      {
        id: 'message-1',
        actorUserId: 'author',
        createdAt: new Date('2026-10-03T12:00:00Z'),
        payload: {
          type: 'comments',
          text: 'Message',
          reactions: [{ emoji: '👍', userIds: ['author'] }],
        },
      },
      'comments',
      viewer,
      new Set(admins),
    );
    expect(result.canEdit).toBe(isOwn);
    expect(result.canDeleteAsAdmin).toBe(canDeleteAsAdmin);
    expect(result.canDelete).toBe(isOwn);
    expect(result.text).toBe('Message');
  });
});
