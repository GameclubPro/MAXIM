import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { marketplaceProfileStateSchema } from '@maxim/contracts/marketplace-integration';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';

test('marketplace pilot preview requires consent, separate publication, and independent append policy in both profiles', async () => {
  const closed = createPreviewApiTransport();
  assert.deepEqual(await closed.request('/marketplace/capability'), { available: false });
  for (const profile of ['moderation', 'publisher']) {
    const api = createPreviewApiTransport({ search: `?marketplacePilot=1&profile=${profile}` });
    for (const kind of ['CHAT', 'CHANNEL']) {
      const path = `/marketplace/entities/${kind}/${kind === 'CHAT' ? 'preview-chat' : 'preview-channel'}/profile?profile=${profile}`;
      const initial = marketplaceProfileStateSchema.parse(await api.request(path));
      assert.equal(initial.listing, null);
      assert.equal(initial.binding.statisticsConsent, false);
      assert.equal(initial.appendEnabled, false);
      const body = {
        requestId: randomUUID(),
        action: 'save',
        expectedRevision: 0,
        details: {
          title: 'Площадка',
          description: '',
          topic: initial.choices.topics[0],
          region: initial.choices.regions[0],
        },
      };
      await assert.rejects(
        api.request(path, { method: 'POST', body: JSON.stringify(body) }),
        /Подтвердите/u,
      );
      const create = { ...body, statisticsConsent: true };
      const draft = marketplaceProfileStateSchema.parse(
        await api.request(path, { method: 'POST', body: JSON.stringify(create) }),
      );
      assert.equal(draft.listing?.status, 'DRAFT');
      assert.equal(draft.listing?.profileOnly, true);
      assert.equal(draft.appendEnabled, false);
      assert.deepEqual(
        await api.request(path, { method: 'POST', body: JSON.stringify(create) }),
        draft,
      );
      const published = marketplaceProfileStateSchema.parse(
        await api.request(path, {
          method: 'POST',
          body: JSON.stringify({
            requestId: randomUUID(),
            action: 'publish',
            expectedRevision: draft.revision,
          }),
        }),
      );
      assert.equal(published.listing?.status, 'PUBLISHED');
      assert.equal(published.appendEnabled, false);
      const enabled = marketplaceProfileStateSchema.parse(
        await api.request(path, {
          method: 'POST',
          body: JSON.stringify({
            requestId: randomUUID(),
            action: 'toggle',
            expectedRevision: published.appendRevision,
            appendEnabled: true,
          }),
        }),
      );
      assert.equal(enabled.appendEnabled, true);
      const revoked = marketplaceProfileStateSchema.parse(
        await api.request(path, {
          method: 'POST',
          body: JSON.stringify({
            requestId: randomUUID(),
            action: 'revoke',
            expectedRevision: enabled.appendRevision,
          }),
        }),
      );
      assert.equal(revoked.binding.state, 'REVOKED');
      assert.equal(revoked.binding.statisticsConsent, false);
      assert.equal(revoked.appendEnabled, false);
      assert.equal(revoked.listing?.status, 'PUBLISHED');
      assert.equal(revoked.listing?.publicUrl, null);
    }
  }
});
