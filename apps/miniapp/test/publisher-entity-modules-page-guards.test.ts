import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pageSource = readFileSync(
  new URL('../src/pages/publisher-entity-modules-page.tsx', import.meta.url),
  'utf8',
);
const pageCss = readFileSync(
  new URL('../src/pages/publisher-entity-modules-page.css', import.meta.url),
  'utf8',
);
const commentsSource = readFileSync(
  new URL('../src/components/publisher-comments-module.tsx', import.meta.url),
  'utf8',
);

test('Publik module workspace owns its settings and never imports Major presentation state', () => {
  assert.match(commentsSource, /chatComments: updatePublisherChatCommentSetting/u);
  assert.match(pageSource, /channelCommentsEnabled/u);
  assert.match(pageSource, /channelSuggestionsEnabled/u);
  assert.match(pageSource, /updatePublisherModules/u);
  assert.doesNotMatch(
    pageSource,
    /channelOverview|settingsHandoff|postSignature|getChats|getChannels/u,
  );
});

test('Publik channels expose comments independently from suggestions', () => {
  assert.match(
    pageSource,
    /channelEnabled=\{entity\.moduleSettings\.channelCommentsEnabled === true\}/u,
  );
  assert.match(commentsSource, /onChange\(\{ channelCommentsEnabled: value \}\)/u);
  assert.doesNotMatch(pageSource, /<small>Посты Публика<\/small>/u);
  assert.match(commentsSource, /<strong>Комментарии<\/strong>/u);
});

test('module labels and refresh feedback avoid internal workflow copy', () => {
  assert.match(pageSource, /<strong>Посты<\/strong>/u);
  assert.match(pageSource, /<strong>Предложения<\/strong>/u);
  assert.doesNotMatch(pageSource, /Постинг|Предложки/u);
  assert.doesNotMatch(pageSource, /Проверка поставлена в очередь|Жду новый статус|MAX ещё/u);
});

test('VK module is capability-gated, lazy, and inactive while its workspace is closed', () => {
  assert.match(pageSource, /lazy\(async \(\) =>/u);
  assert.match(pageSource, /import\('\.\.\/components\/vk-parsing-card'\)/u);
  assert.match(pageSource, /getVkParsingCapability\(api, entityType!, entityId\)/u);
  assert.match(pageSource, /enabled: vkOpen && entityType !== null && entityId\.length > 0/u);
  assert.match(pageSource, /active\s*\n\s*channelLinkUrl/u);
  assert.match(pageSource, /\{vkOpen \? \(/u);
  assert.match(pageSource, /vkCapabilityQuery\.isPending/u);
  assert.match(pageSource, /vkCapabilityQuery\.isError/u);
  assert.match(pageSource, /Не удалось проверить VK/u);
  assert.match(
    pageSource,
    /aria-label=\{vkOpen \? 'Закрыть посты из VK' : 'Открыть посты из VK'\}/u,
  );
  assert.match(pageSource, /<LazyVkWorkspaceShell/u);
  assert.match(pageSource, /onClose=\{\(\) => setVkOpen\(false\)\}/u);
});

test('comment child settings follow the master switch and module rows avoid duplicate statuses', () => {
  assert.match(commentsSource, /disabled=\{pending \|\| disabled\}/u);
  assert.match(
    commentsSource,
    /disabled=\{pending \|\| !enabled \|\| !chatComments\.commentsAdminsEnabled\}/u,
  );
  assert.doesNotMatch(pageSource, /<small>\{entity\.readiness\.canPublish \? 'Доступен'/u);
  assert.doesNotMatch(pageSource, /publisher-entity-module__blocked/u);
  assert.doesNotMatch(pageSource, /<small>\{chatComments\.commentsEnabled/u);
  assert.doesNotMatch(pageSource, /<small>\{entity\.moduleSettings\.channelSuggestionsEnabled/u);
});

test('comments start collapsed and mutually exclusive modes keep details in info dialogs', () => {
  assert.match(commentsSource, /\[open, setOpen\] = useState\(false\)/u);
  assert.match(commentsSource, /aria-expanded=\{open\}/u);
  assert.match(commentsSource, /type="radio"/u);
  assert.match(commentsSource, /<LazySettingsDrilldownPanel/u);
  assert.match(commentsSource, /aria-haspopup="dialog"/u);
});

test('module controls keep stable mobile touch targets without nested module cards', () => {
  assert.match(pageCss, /\.publisher-module-switch \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/u);
  assert.match(pageCss, /\.publisher-entity-module__action \{[\s\S]*?min-height: 44px;/u);
  assert.match(pageCss, /\.publisher-entity-vk-module \{[\s\S]*?display: grid;/u);
  assert.doesNotMatch(pageSource, /<article className="publisher-entity-vk-module"/u);
});
