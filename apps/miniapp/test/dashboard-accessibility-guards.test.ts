import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const participantSheetSource = readFileSync(
  new URL('../src/components/dashboard/chat-participant-sheet.tsx', import.meta.url),
  'utf8',
);
const membershipFeedSource = readFileSync(
  new URL('../src/components/dashboard/membership-activity-feed.tsx', import.meta.url),
  'utf8',
);

test('participant moderation composers expose stable disclosure relationships', () => {
  assert.match(
    participantSheetSource,
    /participant-sheet__action--mute[\s\S]*?aria-controls=\{MUTE_COMPOSER_ID\}[\s\S]*?aria-expanded=\{isMuteComposerOpen\}/u,
  );
  assert.match(
    participantSheetSource,
    /participant-sheet__action--immunity[\s\S]*?aria-controls=\{IMMUNITY_COMPOSER_ID\}[\s\S]*?aria-expanded=\{isImmunityComposerOpen\}/u,
  );
  assert.match(
    participantSheetSource,
    /<div id=\{MUTE_COMPOSER_ID\} className="participant-sheet__composer">/u,
  );
  assert.match(
    participantSheetSource,
    /id=\{IMMUNITY_COMPOSER_ID\}[\s\S]*?className="participant-sheet__composer participant-sheet__composer--stack"/u,
  );
});

test('participant immunity radios use one tab stop and full radio-group keyboard navigation', () => {
  assert.match(participantSheetSource, /tabIndex=\{immunityMode === 'limited' \? 0 : -1\}/u);
  assert.match(participantSheetSource, /tabIndex=\{immunityMode === 'always' \? 0 : -1\}/u);

  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
    assert.match(participantSheetSource, new RegExp(`key === '${key}'`, 'u'));
  }

  assert.match(participantSheetSource, /event\.preventDefault\(\);/u);
  assert.match(participantSheetSource, /setImmunityMode\(nextMode\);/u);
  assert.match(participantSheetSource, /data-immunity-mode="\$\{nextMode\}"[\s\S]*?\.focus\(\);/u);
});

test('membership activity exposes one keyboard profile action per participant', () => {
  assert.match(
    membershipFeedSource,
    /className="membership-feed__avatar-link"\s+aria-label=\{`Открыть профиль \$\{displayName\} в MAX`\}\s+tabIndex=\{-1\}/u,
  );
  assert.doesNotMatch(
    membershipFeedSource,
    /className="membership-feed__avatar-link"[\s\S]{0,160}?aria-hidden/u,
  );
  assert.match(
    membershipFeedSource,
    /className="membership-feed__name-link"[\s\S]*?handleProfileLinkClick/u,
  );
  assert.doesNotMatch(
    membershipFeedSource,
    /className="membership-feed__name-link"[\s\S]{0,120}?tabIndex=\{-1\}/u,
  );
});
