import assert from 'node:assert/strict';
import test from 'node:test';
import { PublisherSuggestionDraftOpenGate } from '../src/pages/publisher-suggestion-draft-open-gate';

test('blocks duplicate draft opens and navigation synchronously', () => {
  const gate = new PublisherSuggestionDraftOpenGate();

  assert.equal(gate.tryStart(' suggestion-1 '), 'suggestion-1');
  assert.equal(gate.tryStart('suggestion-1'), null);
  assert.equal(gate.tryStart('suggestion-2'), null);

  gate.finish('suggestion-1');
  assert.equal(gate.tryStart('suggestion-2'), 'suggestion-2');
  assert.equal(gate.tryCommitNavigation(), true);
  assert.equal(gate.tryCommitNavigation(), false);
  assert.equal(gate.tryStart('suggestion-3'), null);
});

test('reset clears pending work and can permanently block an unmounted screen', () => {
  const gate = new PublisherSuggestionDraftOpenGate();

  assert.equal(gate.tryStart('suggestion-1'), 'suggestion-1');
  gate.reset();
  assert.equal(gate.tryStart('suggestion-2'), 'suggestion-2');
  gate.reset(true);
  assert.equal(gate.tryStart('suggestion-3'), null);
  assert.equal(gate.tryCommitNavigation(), false);
});
