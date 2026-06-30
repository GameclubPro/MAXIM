import assert from 'node:assert/strict';
import test from 'node:test';
import { applySectionToAllResponseSchema } from '@maxim/contracts/settings';
import { createDefaultApplySettingsTarget } from '../src/pages/settings/settings-apply-target';

test('settings apply target defaults to current chat', () => {
  assert.deepEqual(createDefaultApplySettingsTarget(), {
    mode: 'current',
    favoriteTypes: [],
    chatIds: [],
  });
});

test('apply section response fallback defaults to current target mode', () => {
  const parsed = applySectionToAllResponseSchema.parse({
    section: 'links',
    sourceChatId: 'chat-1',
    updatedChats: 1,
    appliedChatIds: ['chat-1'],
  });

  assert.equal(parsed.targetMode, 'current');
});
