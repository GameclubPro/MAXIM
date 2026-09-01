import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolveChannelDialogProfileCapabilities } from '../src/lib/channel-dialog-profile-capabilities';

const appSource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8');
const lazyPagesSource = readFileSync(
  new URL('../src/pages/lazy-pages.ts', import.meta.url),
  'utf8',
);
const dialogPageSource = readFileSync(
  new URL('../src/pages/channel-dialog-page.tsx', import.meta.url),
  'utf8',
);

test('comment capabilities keep Major-routed controls out of Publisher', () => {
  assert.deepEqual(resolveChannelDialogProfileCapabilities('publisher'), {
    canManageCommentNotifications: false,
    canUploadCommentAttachments: false,
    canUploadSuggestionImages: true,
  });
  assert.deepEqual(resolveChannelDialogProfileCapabilities('moderation'), {
    canManageCommentNotifications: true,
    canUploadCommentAttachments: true,
    canUploadSuggestionImages: true,
  });
});

test('comment routes pass their authenticated profile into the lazy page', () => {
  assert.match(lazyPagesSource, /ProfiledRoutedPageProps[\s\S]*?profile: MiniappProfile/u);
  assert.match(
    appSource,
    /path="\/channel\/:chatId\/dialog\/comments"[\s\S]*?profile=\{me\.profile\}/u,
  );
  assert.match(
    appSource,
    /path="\/chat\/:chatId\/dialog\/comments"[\s\S]*?profile=\{me\.profile\}/u,
  );
});

test('Publisher comments hide notification and upload controls with payload guards', () => {
  assert.match(dialogPageSource, /resolveChannelDialogProfileCapabilities\(profile\)/u);
  assert.match(
    dialogPageSource,
    /canManageCommentNotifications \? \([\s\S]*?aria-label="Настройки уведомлений"/u,
  );
  assert.match(
    dialogPageSource,
    /canManageCommentNotifications && dialogType === 'comments' && isNotificationSettingsOpen/u,
  );
  assert.match(
    dialogPageSource,
    /!editingMessage && canUploadCommentAttachments \? \([\s\S]*?type="file"/u,
  );
  assert.match(
    dialogPageSource,
    /if \(!canUploadCommentAttachments \|\| files\.length === 0 \|\| editingMessage\)/u,
  );
  assert.match(
    dialogPageSource,
    /const attachments = canUploadCommentAttachments \? payload\.attachments : \[\]/u,
  );
});

test('Publisher comments retain text, replies, reactions, and own-message editing', () => {
  assert.match(dialogPageSource, /const handleReply = \(message: ChannelDialogMessage\)/u);
  assert.match(dialogPageSource, /const handleReactionToggle =/u);
  assert.match(
    dialogPageSource,
    /const handleStartEditing = \(message: ChannelDialogMessage\)[\s\S]*?if \(!message\.canEdit\)/u,
  );
  assert.match(dialogPageSource, /placeholder=\{viewModel\.placeholder\}/u);
});
