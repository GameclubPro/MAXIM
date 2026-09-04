import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildVkParsingSourceDailyLimitUpdate,
  buildVkParsingSourceIntervalUpdate,
  createVkParsingNumberDraftState,
  parseVkParsingIntegerDraft,
  reduceVkParsingNumberDraft,
  resolveCommonVkParsingSourceValue,
  resolveVkParsingCommonNumericInput,
} from '../src/components/vk-parsing/model';

test('VK common tempo keeps interval and daily-limit payloads independent', () => {
  assert.deepEqual(buildVkParsingSourceIntervalUpdate(20), {
    publishIntervalMinutes: 20,
  });
  assert.equal('dailyLimit' in buildVkParsingSourceIntervalUpdate(180), false);

  assert.deepEqual(buildVkParsingSourceDailyLimitUpdate('12'), { dailyLimit: 12 });
  assert.equal('publishIntervalMinutes' in buildVkParsingSourceDailyLimitUpdate('12')!, false);
});

test('VK common daily limit represents mixed values without choosing one silently', () => {
  assert.equal(resolveCommonVkParsingSourceValue([8, 8]), 8);
  assert.equal(resolveCommonVkParsingSourceValue([3, 9]), null);
  assert.equal(resolveCommonVkParsingSourceValue([]), null);
  assert.deepEqual(resolveVkParsingCommonNumericInput([8, 8]), { value: 8, mixed: false });
  assert.deepEqual(resolveVkParsingCommonNumericInput([3, 9]), { value: '', mixed: true });
  assert.deepEqual(resolveVkParsingCommonNumericInput([]), { value: '', mixed: false });
});

test('VK common daily limit accepts only integer contract values from 1 through 500', () => {
  assert.equal(buildVkParsingSourceDailyLimitUpdate(''), null);
  assert.equal(buildVkParsingSourceDailyLimitUpdate('0'), null);
  assert.equal(buildVkParsingSourceDailyLimitUpdate('1.5'), null);
  assert.equal(buildVkParsingSourceDailyLimitUpdate('501'), null);
  assert.deepEqual(buildVkParsingSourceDailyLimitUpdate('1'), { dailyLimit: 1 });
  assert.deepEqual(buildVkParsingSourceDailyLimitUpdate('500'), { dailyLimit: 500 });
});

test('VK numeric draft keeps an empty minimum-pause edit distinct from zero', () => {
  assert.equal(parseVkParsingIntegerDraft('', 0, 1440), null);
  assert.equal(parseVkParsingIntegerDraft('0', 0, 1440), 0);
});

test('VK mixed daily-limit draft accepts sequential multi-digit typing before commit', () => {
  let state = createVkParsingNumberDraftState(resolveVkParsingCommonNumericInput([3, 9]).value);
  state = reduceVkParsingNumberDraft(state, { type: 'focus' });
  state = reduceVkParsingNumberDraft(state, { type: 'change', draft: '1' });
  assert.deepEqual(state, { draft: '1', editing: true, pendingValue: null });

  state = reduceVkParsingNumberDraft(state, { type: 'sync', serverDraft: '' });
  assert.deepEqual(state, { draft: '1', editing: true, pendingValue: null });
  state = reduceVkParsingNumberDraft(state, { type: 'change', draft: '12' });
  assert.deepEqual(buildVkParsingSourceDailyLimitUpdate(state.draft), { dailyLimit: 12 });

  state = reduceVkParsingNumberDraft(state, { type: 'submit', value: 12 });
  assert.deepEqual(state, { draft: '12', editing: false, pendingValue: 12 });
  state = reduceVkParsingNumberDraft(state, { type: 'sync', serverDraft: '' });
  assert.deepEqual(state, { draft: '12', editing: false, pendingValue: 12 });
  state = reduceVkParsingNumberDraft(state, { type: 'reset', serverDraft: '12' });
  assert.deepEqual(state, { draft: '12', editing: false, pendingValue: null });
});

test('VK daily-limit draft keeps edits local, reverts invalid blur, and syncs while idle', () => {
  let state = createVkParsingNumberDraftState(resolveVkParsingCommonNumericInput([24, 24]).value);
  state = reduceVkParsingNumberDraft(state, { type: 'focus' });
  state = reduceVkParsingNumberDraft(state, { type: 'change', draft: '' });
  state = reduceVkParsingNumberDraft(state, { type: 'sync', serverDraft: '24' });
  assert.equal(state.draft, '');
  assert.equal(buildVkParsingSourceDailyLimitUpdate(state.draft), null);

  state = reduceVkParsingNumberDraft(state, { type: 'reset', serverDraft: '24' });
  assert.deepEqual(state, { draft: '24', editing: false, pendingValue: null });
  state = reduceVkParsingNumberDraft(state, { type: 'sync', serverDraft: '30' });
  assert.deepEqual(state, { draft: '30', editing: false, pendingValue: null });
});

test('VK custom interval draft permits 90 to 30 sequential editing before one commit', () => {
  let state = createVkParsingNumberDraftState(90);
  state = reduceVkParsingNumberDraft(state, { type: 'focus' });
  state = reduceVkParsingNumberDraft(state, { type: 'change', draft: '' });
  state = reduceVkParsingNumberDraft(state, { type: 'change', draft: '3' });
  assert.deepEqual(state, { draft: '3', editing: true, pendingValue: null });
  assert.equal(parseVkParsingIntegerDraft(state.draft, 5, 10080), null);

  state = reduceVkParsingNumberDraft(state, { type: 'change', draft: '30' });
  assert.equal(parseVkParsingIntegerDraft(state.draft, 5, 10080), 30);
  state = reduceVkParsingNumberDraft(state, { type: 'submit', value: 30 });
  assert.deepEqual(state, { draft: '30', editing: false, pendingValue: 30 });
});

test('VK number draft resets immediately when its source set becomes empty', () => {
  let state = createVkParsingNumberDraftState(12);
  state = reduceVkParsingNumberDraft(state, { type: 'focus' });
  state = reduceVkParsingNumberDraft(state, { type: 'change', draft: '120' });
  state = reduceVkParsingNumberDraft(state, { type: 'reset', serverDraft: '' });
  assert.deepEqual(state, { draft: '', editing: false, pendingValue: null });
});
