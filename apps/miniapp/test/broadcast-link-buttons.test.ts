import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_BROADCAST_BUTTON_TEXT } from '@maxim/contracts';
import {
  buildBroadcastLinkButtonLegacyFields,
  createEmptyBroadcastLinkButton,
  hasBroadcastLinkButtonErrors,
  trimBroadcastLinkButtons,
  validateBroadcastLinkButtons,
} from '../src/lib/broadcast-link-buttons';

test('creates new broadcast link buttons with the default visible text', () => {
  assert.deepEqual(createEmptyBroadcastLinkButton(), {
    text: DEFAULT_BROADCAST_BUTTON_TEXT,
    url: '',
  });
});

test('defaults blank broadcast button text while preserving url validation', () => {
  const buttons = trimBroadcastLinkButtons([
    {
      text: '   ',
      url: ' https://example.com/post ',
    },
  ]);

  assert.deepEqual(buttons, [
    {
      text: DEFAULT_BROADCAST_BUTTON_TEXT,
      url: 'https://example.com/post',
    },
  ]);
  assert.equal(hasBroadcastLinkButtonErrors(validateBroadcastLinkButtons(buttons)), false);
});

test('builds legacy fields with default text for a pasted link-only button', () => {
  const state = buildBroadcastLinkButtonLegacyFields([
    {
      text: '',
      url: 'https://example.com/post',
    },
  ]);

  assert.equal(state.buttonEnabled, true);
  assert.equal(state.buttonText, DEFAULT_BROADCAST_BUTTON_TEXT);
  assert.deepEqual(state.buttons, [
    {
      text: DEFAULT_BROADCAST_BUTTON_TEXT,
      url: 'https://example.com/post',
    },
  ]);
});
