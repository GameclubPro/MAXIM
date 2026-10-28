import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';
import { advertisingStateSchema } from '@maxim/contracts/advertising-placement';
import { applySettingsSectionSchema, chatSettingsSchema } from '@maxim/contracts/settings';
import {
  MINIAPP_VISUAL_PRESETS,
  MINIAPP_VISUAL_SCENARIOS,
} from '../../../scripts/miniapp-visual-scenarios.mjs';

const pageSource = readFileSync(
  new URL('../src/pages/settings-page.legacy.tsx', import.meta.url),
  'utf8',
);
test('Birzhik replaces both pilot advertising entries with one available module', () => {
  assert.doesNotMatch(pageSource, /<SettingsAdvertisingSection\s/u);
  assert.equal((pageSource.match(/<MarketplaceProfileCard\s/gu) ?? []).length, 1);
  const card = readFileSync(
    new URL('../src/components/marketplace-profile-card.tsx', import.meta.url),
    'utf8',
  );
  assert.match(card, /aria-label="Биржик"/u);
  assert.doesNotMatch(card, /marketplace\/capability|capability\.data|323459159/u);
  assert.match(card, /data-settings-navigation-entry="true"/u);
});

test('the shared button policy does not enter chat settings bulk apply', () => {
  for (const name of [
    'advertising',
    'advertisingEnabled',
    'svyazka',
    'svyazkaAdvertisingEnabled',
  ]) {
    assert.equal(applySettingsSectionSchema.safeParse(name).success, false);
    assert.equal(Object.hasOwn(chatSettingsSchema.parse({ [name]: true }), name), false);
  }
});

test('Birzhik has entry and opened-profile browser captures', () => {
  for (const name of ['chat-settings-birzhik', 'chat-settings-birzhik-profile']) {
    assert.equal(
      MINIAPP_VISUAL_SCENARIOS.find((item) => item.name === name)?.routeId,
      'chat-settings',
    );
  }
  assert.ok(MINIAPP_VISUAL_PRESETS.smoke.scenarioNames.includes('chat-settings'));
  const captureSource = readFileSync(
    new URL('../../../scripts/capture-miniapp-preview.mjs', import.meta.url),
    'utf8',
  );
  assert.match(captureSource, /name: 'chat-settings',[\s\S]*?await assertBirzhikModule\(page\)/u);
});

test('pilot availability comes from the authenticated server capability, not a client identity constant', () => {
  const source = readFileSync(
    new URL('../src/pages/settings/settings-advertising-section.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /api\.request\('\/advertising-placement\/capability'\)/u);
  assert.match(source, /if \(!capability\.data\?\.available \|\| capability\.isError\)/u);
  assert.match(source, /return <SettingsAdvertisingSoonSection \/>/u);
  assert.doesNotMatch(source, /323459159|initDataUnsafe/u);
});

test('a pending send supersedes the old result and explicit settings changes reset request context', () => {
  const source = readFileSync(
    new URL('../src/pages/settings/settings-advertising-workspace.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /const status = send\.isPending \? 'SENDING' : data\.lastSend\?\.status/u);
  assert.match(
    source,
    /onSuccess: \(state\) => \{\s*requestId\.current = null;\s*setAcknowledgedId\(null\)/u,
  );
});

test('isolated preview keeps nonpilot closed and supports explicit pilot enable, send and disable', async () => {
  const closed = createPreviewApiTransport({ search: '' });
  assert.deepEqual(await closed.request('/advertising-placement/capability'), { available: false });
  await assert.rejects(
    closed.request('/chats/-100/advertising-placement', { method: 'PUT', body: '{}' }),
  );
  const preview = createPreviewApiTransport({ search: '?advertisingPilot=1' });
  const chats = (await preview.request('/chats')) as { id: string }[];
  const path = `/chats/${encodeURIComponent(chats[0].id)}/advertising-placement`;
  advertisingStateSchema.parse(await preview.request(path));
  assert.deepEqual(await preview.request('/advertising-placement/capability'), { available: true });
  await preview.request(path, {
    method: 'PUT',
    body: JSON.stringify({ enabled: true, revision: 0 }),
  });
  const request = {
    requestId: '10000000-0000-4000-8000-000000000001',
    revision: 1,
    previousSendId: null,
  };
  const first = await preview.request(`${path}/send`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
  assert.deepEqual(
    await preview.request(`${path}/send`, { method: 'POST', body: JSON.stringify(request) }),
    first,
  );
  await preview.request(path, {
    method: 'PUT',
    body: JSON.stringify({ enabled: false, revision: 1 }),
  });
  await assert.rejects(
    preview.request(`${path}/send`, {
      method: 'POST',
      body: JSON.stringify({ ...request, requestId: '10000000-0000-4000-8000-000000000002' }),
    }),
  );
  const publisher = createPreviewApiTransport({ search: '?advertisingPilot=1&profile=publisher' });
  assert.deepEqual(await publisher.request('/advertising-placement/capability'), {
    available: false,
  });
});
