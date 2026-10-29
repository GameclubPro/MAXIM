import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chatSettingsSchema,
  stopWordsPolicySchema,
  type ChatSettings,
  type StopWordsState,
} from '@maxim/contracts/settings';
import { ApiRequestError } from '../src/lib/api-request-error';
import type { ApiTransport } from '../src/lib/api/transport';
import {
  hasOrdinarySettingsChanges,
  mergeConfirmedStopWordsReceipt,
  rebaseSettingsAfterStopWordsSave,
  saveStopWordsSettings,
  saveWorkspaceSettings,
  type SettingsSaveProgress,
} from '../src/pages/settings/settings-save-coordinator';

const revision = '2026-10-29T08:00:00.000Z';
const savedRevision = '2026-10-29T08:01:00.000Z';
const refreshedRevision = '2026-10-29T08:02:00.000Z';
const policy = stopWordsPolicySchema.parse({
  enabled: true,
  rules: [
    { id: 'exact', value: 'казино', kind: 'WORD', enabled: true, matchMode: 'EXACT' },
    { id: 'masked', value: 'реклама', kind: 'WORD', enabled: true, matchMode: 'MASKED' },
  ],
  domains: ['blocked.example'],
});
const baseline = chatSettingsSchema.parse({
  settingsRevision: revision,
  stopWordsPolicy: policy,
  stopWordsRevision: 7,
  antiSpamEnabled: false,
  messageCountLimitMessages: 5,
});
const edited = (): ChatSettings => ({
  ...structuredClone(baseline),
  stopWordsPolicy: { ...structuredClone(policy), domains: ['blocked.example', 'new.example'] },
});
const receipt = (draft: ChatSettings): StopWordsState => ({
  policy: draft.stopWordsPolicy!,
  revision: 8,
  settingsRevision: savedRevision,
  imageScanStatus: 'shadow',
  storageStatus: 'valid',
});
const transport = (request: ApiTransport['request']): ApiTransport => ({
  request,
  requestKeepalive() {},
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('stop-only workspace save sends one stop CAS and preserves explicit matching modes', async () => {
  const draft = edited();
  draft.stopWordsPolicy!.imageScanEnabled = true;
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const progress: SettingsSaveProgress[] = [];
  const api = transport(async (path, init) => {
    calls.push({ path, body: JSON.parse(String(init?.body)) });
    assert.equal(init?.method, 'PUT');
    return receipt(draft);
  });
  assert.equal(hasOrdinarySettingsChanges(draft, baseline), false);
  const result = await saveWorkspaceSettings(
    api,
    { chatId: 'chat-a', baseline, draft },
    (event) => {
      progress.push(event);
    },
  );
  assert.deepEqual(calls, [
    {
      path: '/chats/chat-a/stop-words',
      body: { policy: draft.stopWordsPolicy, expectedRevision: 7 },
    },
  ]);
  assert.deepEqual(result, { stopWords: receipt(draft) });
  assert.equal((calls[0].body.policy as typeof policy).imageScanEnabled, true);
  assert.deepEqual(
    progress.map((event) => event.kind),
    ['stopWords'],
  );
  assert.deepEqual(
    result.stopWords?.policy.rules.map((rule) => rule.matchMode),
    ['EXACT', 'MASKED'],
  );
});

test('mixed workspace save awaits ordinary progress before stop CAS using original policy and revision', async () => {
  const draft = { ...edited(), antiSpamEnabled: true };
  const submitted = structuredClone(draft);
  const gate = deferred();
  const ordinaryProgress = deferred();
  const sequence: string[] = [];
  const api = transport(async (path, init) => {
    const body = JSON.parse(String(init?.body));
    if (path.endsWith('/settings')) {
      sequence.push('ordinary request');
      assert.equal(body.settingsRevision, revision);
      for (const key of [
        'stopWordsPolicy',
        'stopWordsRevision',
        'messageLimitsBlockedWords',
        'messageLimitsBlockedDomains',
        'messageLimitsImageTextScanEnabled',
      ])
        assert.equal(Object.hasOwn(body, key), false, key);
      return {
        ...baseline,
        antiSpamEnabled: true,
        stopWordsRevision: 99,
        settingsRevision: savedRevision,
      };
    }
    sequence.push('stop request');
    assert.equal(path, '/chats/chat-a/stop-words');
    assert.deepEqual(body, { policy: submitted.stopWordsPolicy, expectedRevision: 7 });
    return receipt(submitted);
  });
  const saving = saveWorkspaceSettings(
    api,
    { chatId: 'chat-a', baseline, draft },
    async (event) => {
      sequence.push(`${event.kind} progress`);
      if (event.kind === 'ordinary') {
        assert.equal(event.saved.stopWordsRevision, 99);
        ordinaryProgress.resolve();
        await gate.promise;
      }
    },
  );
  await ordinaryProgress.promise;
  assert.deepEqual(sequence, ['ordinary request', 'ordinary progress']);
  draft.stopWordsPolicy!.domains.push('typed-during-save.example');
  draft.stopWordsRevision = 100;
  gate.resolve();
  await saving;
  assert.deepEqual(sequence, [
    'ordinary request',
    'ordinary progress',
    'stop request',
    'stopWords progress',
  ]);
});

test('ordinary failure prevents stop save and stop failure reports only acknowledged ordinary progress', async () => {
  for (const failure of ['ordinary', 'stopWords'] as const) {
    const draft = { ...edited(), antiSpamEnabled: true };
    const progress: SettingsSaveProgress[] = [];
    const calls: string[] = [];
    const api = transport(async (path) => {
      calls.push(path);
      if (path.endsWith('/settings')) {
        if (failure === 'ordinary') throw new Error('ordinary failed');
        return { ...baseline, antiSpamEnabled: true, settingsRevision: savedRevision };
      }
      throw new Error('stopWords failed');
    });
    await assert.rejects(
      saveWorkspaceSettings(api, { chatId: 'chat-a', baseline, draft }, (event) => {
        progress.push(event);
      }),
      /failed/u,
    );
    assert.deepEqual(
      calls,
      failure === 'ordinary'
        ? ['/chats/chat-a/settings']
        : ['/chats/chat-a/settings', '/chats/chat-a/stop-words'],
    );
    assert.deepEqual(
      progress.map((event) => event.kind),
      failure === 'ordinary' ? [] : ['ordinary'],
    );
    assert.deepEqual(draft.stopWordsPolicy, edited().stopWordsPolicy);
    assert.equal(draft.stopWordsRevision, 7);
  }
});

test('replacement approval is bound to chat and stop revision and alone makes workspace dirty', async () => {
  for (const replacement of [
    undefined,
    { chatId: 'chat-b', expectedRevision: 7 },
    { chatId: 'chat-a', expectedRevision: 6 },
  ]) {
    let writes = 0;
    await assert.rejects(
      saveWorkspaceSettings(
        transport(async () => {
          writes++;
        }),
        {
          chatId: 'chat-a',
          baseline,
          draft: { ...edited(), antiSpamEnabled: true },
          storageStatus: 'invalid',
          replacement,
        },
        () => {},
      ),
      (error: unknown) =>
        error instanceof ApiRequestError && error.code === 'STOP_WORDS_POLICY_REVIEW_REQUIRED',
    );
    assert.equal(writes, 0);
  }
  const calls: unknown[] = [];
  const api = transport(async (_path, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return receipt(baseline);
  });
  await saveWorkspaceSettings(
    api,
    {
      chatId: 'chat-a',
      baseline,
      draft: baseline,
      storageStatus: 'invalid',
      replacement: { chatId: 'chat-a', expectedRevision: 7 },
    },
    () => {},
  );
  assert.deepEqual(calls, [{ policy, expectedRevision: 7, replaceInvalidStorage: true }]);
});

test('lost response retry repeats exact policy, CAS and intent; review-required never adds replacement intent', async () => {
  for (const approved of [false, true]) {
    const calls: unknown[] = [];
    const draft = edited();
    const api = transport(async (_path, init) => {
      calls.push(JSON.parse(String(init?.body)));
      if (calls.length === 1) throw new Error('lost response');
      return receipt(draft);
    });
    const input = {
      chatId: 'chat-a',
      draft,
      storageStatus: approved ? ('invalid' as const) : ('valid' as const),
      ...(approved ? { replacement: { chatId: 'chat-a', expectedRevision: 7 } } : {}),
    };
    await assert.rejects(saveStopWordsSettings(api, input), /lost response/u);
    await saveStopWordsSettings(api, input);
    assert.deepEqual(calls[0], calls[1]);
    assert.equal(Object.hasOwn(calls[0] as object, 'replaceInvalidStorage'), approved);
  }
  const bodies: unknown[] = [];
  const api = transport(async (_path, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    throw new ApiRequestError(
      409,
      JSON.stringify({ code: 'STOP_WORDS_POLICY_REVIEW_REQUIRED', revision: 7 }),
      'Проверьте список',
    );
  });
  await assert.rejects(
    saveStopWordsSettings(api, { chatId: 'chat-a', draft: edited(), storageStatus: 'valid' }),
  );
  assert.equal(bodies.length, 1);
  assert.equal(Object.hasOwn(bodies[0] as object, 'replaceInvalidStorage'), false);
});

test('stop receipt preserves general revision and edits made after submission', () => {
  const submitted = edited();
  const current = { ...structuredClone(submitted), messageCountLimitMessages: 9 };
  current.stopWordsPolicy!.domains.push('newer-draft.example');
  const merged = mergeConfirmedStopWordsReceipt({
    current,
    submitted,
    receipt: receipt(submitted),
  });
  assert.equal(merged.settingsRevision, revision);
  assert.equal(merged.messageCountLimitMessages, 9);
  assert.deepEqual(merged.stopWordsPolicy, current.stopWordsPolicy);
  assert.equal(merged.stopWordsRevision, 8);
  const newer = { ...current, stopWordsRevision: 10 };
  assert.equal(
    mergeConfirmedStopWordsReceipt({ current: newer, submitted, receipt: receipt(submitted) }),
    newer,
  );
});

test('complete stop refresh safely rebases independent edits and preserves overlap fences', () => {
  const submitted = edited();
  const saved = receipt(submitted);
  const current = {
    ...mergeConfirmedStopWordsReceipt({ current: submitted, submitted, receipt: saved }),
    messageCountLimitMessages: 9,
  };
  const fresh = {
    ...baseline,
    stopWordsPolicy: saved.policy,
    stopWordsRevision: saved.revision,
    antiSpamEnabled: true,
    settingsRevision: refreshedRevision,
  };
  const rebased = rebaseSettingsAfterStopWordsSave({
    current,
    baseline,
    fresh,
    receipt: saved,
    submitted,
  });
  assert.equal(rebased.settingsRevision, refreshedRevision);
  assert.equal(rebased.antiSpamEnabled, true);
  assert.equal(rebased.messageCountLimitMessages, 9);
  assert.deepEqual(rebased.stopWordsPolicy, submitted.stopWordsPolicy);
  const overlap = rebaseSettingsAfterStopWordsSave({
    current,
    baseline,
    fresh: { ...fresh, messageCountLimitMessages: 10 },
    receipt: saved,
    submitted,
  });
  assert.equal(overlap.settingsRevision, revision);
  assert.equal(overlap.messageCountLimitMessages, 9);
  for (const incomplete of [
    { ...saved, settingsRevision: undefined },
    { ...saved, settingsRevision: refreshedRevision },
  ]) {
    assert.equal(
      rebaseSettingsAfterStopWordsSave({
        current,
        baseline,
        fresh: { ...fresh, settingsRevision: revision },
        receipt: incomplete,
      }),
      current,
    );
  }
});

test('stop refresh merges bot media per field and retains the old fence for an overlapping image', () => {
  const submitted = edited();
  const saved = receipt(submitted);
  const media = { base64: 'aGVsbG8=', mimeType: 'image/png' };
  const current = {
    ...submitted,
    botSpeechMedia: { ...submitted.botSpeechMedia, greetingBotMessageText: media },
  };
  const fresh = {
    ...baseline,
    stopWordsPolicy: saved.policy,
    stopWordsRevision: saved.revision,
    settingsRevision: refreshedRevision,
    botSpeechMedia: { ...baseline.botSpeechMedia, linkWarnMessageText: media },
  };
  const safe = rebaseSettingsAfterStopWordsSave({ current, baseline, fresh, receipt: saved });
  assert.equal(safe.settingsRevision, refreshedRevision);
  assert.deepEqual(safe.botSpeechMedia.greetingBotMessageText, media);
  assert.deepEqual(safe.botSpeechMedia.linkWarnMessageText, media);
  const overlapping = rebaseSettingsAfterStopWordsSave({
    current,
    baseline,
    fresh: {
      ...fresh,
      botSpeechMedia: { greetingBotMessageText: { ...media, base64: 'd29ybGQ=' } },
    },
    receipt: saved,
  });
  assert.equal(overlapping.settingsRevision, revision);
  assert.deepEqual(overlapping.botSpeechMedia.greetingBotMessageText, media);
});
