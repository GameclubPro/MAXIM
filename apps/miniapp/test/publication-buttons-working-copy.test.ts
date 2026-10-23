import assert from 'node:assert/strict';
import test from 'node:test';
import { havePublicationButtonsChanged } from '../src/features/publications/publication-buttons-working-copy';
import { createEmptyBroadcastLinkButton } from '../src/lib/broadcast-link-buttons';

test('pristine synthetic and added empty rows do not claim lost changes', () => {
  const synthetic = createEmptyBroadcastLinkButton();
  assert.equal(havePublicationButtonsChanged([synthetic], []), false);
  assert.equal(
    havePublicationButtonsChanged([synthetic], [synthetic, { text: '', url: '' }]),
    false,
  );
  assert.equal(havePublicationButtonsChanged([], [{ text: ' ', url: ' ' }]), false);
});

test('partially entered names and links, removals, and order remain protected', () => {
  const first = { text: 'Каталог', url: 'https://example.com/catalog' };
  const second = { text: 'Контакты', url: 'https://example.com/contacts' };
  assert.equal(havePublicationButtonsChanged([], [{ text: 'Новая', url: '' }]), true);
  assert.equal(havePublicationButtonsChanged([], [{ text: '', url: 'htt' }]), true);
  assert.equal(havePublicationButtonsChanged([first], []), true);
  assert.equal(havePublicationButtonsChanged([first, second], [second, first]), true);
  assert.equal(
    havePublicationButtonsChanged([first], [{ ...first }, { text: '', url: '' }]),
    false,
  );
});
