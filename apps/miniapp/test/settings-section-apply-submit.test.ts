import assert from 'node:assert/strict';
import test from 'node:test';
import { chatSettingsSchema } from '@maxim/contracts/settings';
import type { ApiTransport } from '../src/lib/api/transport';
import {
  applySettingsSectionWithConfirmedSource,
  refreshSavedStopWordsSource,
  type SettingsApplySavedSource,
} from '../src/pages/settings/settings-section-apply-submit';

const draftRevision = '2026-10-01T10:00:00.000Z';
const savedRevision = '2026-10-01T11:00:00.000Z';

test('report bulk submission retains the saved source when confirmed-target apply fails', async () => {
  const sourceSettings = chatSettingsSchema.parse({ settingsRevision: draftRevision });
  const saved = { ...sourceSettings, settingsRevision: savedRevision };
  const snapshots: Array<SettingsApplySavedSource | null> = [];
  let applyBody: Record<string, unknown> | undefined;
  const api: ApiTransport = {
    request: async (path, options) => {
      if (path.endsWith('/settings/section')) return saved;
      assert.equal(path, '/chats/source/settings/apply-section-to-all');
      assert.equal(snapshots.at(-1)?.settings.settingsRevision, savedRevision);
      assert.equal(options?.retryMutationOnTransportError, false);
      applyBody = JSON.parse(String(options?.body));
      throw new Error('target unavailable');
    },
    requestKeepalive: () => {},
  };
  await assert.rejects(
    applySettingsSectionWithConfirmedSource(
      api,
      {
        sourceChatId: 'source',
        section: 'reports',
        sourceSettings,
        target: { mode: 'selectedChats', favoriteTypes: [], chatIds: ['target'] },
        confirmedTargetChatIds: ['target'],
      },
      (snapshot) => snapshots.push(snapshot),
    ),
    /target unavailable/u,
  );
  assert.equal(snapshots[0], null);
  assert.equal(snapshots.at(-1)?.sourceChatId, 'source');
  assert.equal(applyBody?.expectedSourceSettingsRevision, savedRevision);
  assert.deepEqual(applyBody?.confirmedTargetChatIds, ['target']);
});

test('failed stop-word recovery preserves the last confirmed source snapshot', async () => {
  const savedSource: SettingsApplySavedSource = {
    sourceChatId: 'source',
    section: 'stopWords',
    settings: chatSettingsSchema.parse({ settingsRevision: savedRevision }),
  };
  const api: ApiTransport = {
    request: async () => {
      throw new Error('transport unavailable');
    },
    requestKeepalive: () => {},
  };
  assert.equal(await refreshSavedStopWordsSource(api, savedSource), savedSource);
});
