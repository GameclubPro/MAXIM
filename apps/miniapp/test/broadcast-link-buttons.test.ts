import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_BROADCAST_BUTTON_TEXT } from '@maxim/contracts';
import {
  buildBroadcastLinkButtonLegacyFields,
  buildBroadcastPreviewButtonRows,
  createEmptyBroadcastLinkButton,
  formatBroadcastButtonsPreview,
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

test('uses contract-level URL validation for broadcast link buttons', () => {
  const errors = validateBroadcastLinkButtons([
    {
      text: 'Связь',
      url: 'https://max.ru/bot?start=pmh-user-1',
    },
  ]);

  assert.equal(hasBroadcastLinkButtonErrors(errors), true);
  assert.equal(errors[0]?.url, 'Укажите корректную ссылку (http/https).');
});

test('keeps text validation separate from broadcast button URL errors', () => {
  const errors = validateBroadcastLinkButtons([
    {
      text: 'Очень длинное название кнопки больше лимита',
      url: 'https://example.com/post',
    },
  ]);

  assert.equal(hasBroadcastLinkButtonErrors(errors), true);
  assert.equal(errors[0]?.url, undefined);
  assert.equal(errors[0]?.text, 'Введите название кнопки до 32 символов.');
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

test('formats button previews with user-visible names', () => {
  assert.equal(
    formatBroadcastButtonsPreview([
      { text: 'Канал', url: 'https://example.com/channel' },
      { text: 'Бот', url: 'https://example.com/bot' },
    ]),
    'Канал, Бот',
  );

  assert.equal(
    formatBroadcastButtonsPreview([
      { text: 'Канал', url: 'https://example.com/channel' },
      { text: 'Бот', url: 'https://example.com/bot' },
      { text: 'Правила', url: 'https://example.com/rules' },
    ]),
    'Канал, Бот +1',
  );
});

test('renders publication link buttons as one full-width button per row', () => {
  const buttons = Array.from({ length: 4 }, (_, index) => ({ text: `Кнопка ${index + 1}` }));

  assert.deepEqual(buildBroadcastPreviewButtonRows(buttons, []), [
    buttons.slice(0, 3),
    buttons.slice(3),
  ]);
  assert.deepEqual(
    buildBroadcastPreviewButtonRows(buttons, [], 1),
    buttons.map((button) => [button]),
  );
});
