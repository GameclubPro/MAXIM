import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sheetSource = readFileSync(
  new URL('../src/features/publications/publication-buttons-sheet.tsx', import.meta.url),
  'utf8',
);
const sheetCss = readFileSync(
  new URL('../src/features/publications/publication-buttons-sheet.css', import.meta.url),
  'utf8',
);
test('publication buttons use a transactional sheet without a duplicate preview or toggle', () => {
  assert.match(sheetSource, /const \[workingButtons, setWorkingButtons\] = useState/u);
  assert.match(sheetSource, /onApply\(\[\]\)/u);
  assert.match(sheetSource, /const appliedButtons = workingButtons\.map/u);
  assert.match(sheetSource, /onApply\(appliedButtons\)/u);
  assert.match(
    sheetSource,
    /const discard = useCallback\(\(\) => \{[\s\S]*?setWorkingButtons\(createWorkingButtons\(buttons\)\)/u,
  );
  assert.doesNotMatch(
    sheetSource,
    /BroadcastLinkButtonsEditor|ButtonPreview|onEnabledChange|type="checkbox"|settings-native-switch/u,
  );
});

test('publication button errors are revealed after blur or Done and use publication URL rules', () => {
  assert.match(sheetSource, /publicationButtonSchema\.safeParse/u);
  assert.match(sheetSource, /onBlur=\{\(\) => touchField\(index, 'url'\)\}/u);
  assert.match(sheetSource, /workingButtons\.map\(\(\) => \(\{\s*text: true,\s*url: true/u);
  assert.match(sheetSource, /aria-invalid=\{Boolean\(error\.text\) \|\| undefined\}/u);
  assert.match(sheetSource, /aria-invalid=\{Boolean\(error\.url\) \|\| undefined\}/u);
  assert.match(sheetSource, /aria-describedby=\{error\.url \? urlErrorId : undefined\}/u);
});

test('publication buttons keep primary touch targets at least 44px tall', () => {
  assert.match(sheetCss, /\.publication-buttons-sheet__remove \{[\s\S]*?height: 44px;/u);
  assert.match(
    sheetCss,
    /\.publication-buttons-sheet__field > input \{[\s\S]*?min-height: 44px;[\s\S]*?font-size: 16px;/u,
  );
  assert.match(sheetCss, /\.publication-buttons-sheet__done \{[\s\S]*?min-height: 48px;/u);
});

test('publication buttons follow the visual viewport without stealing an existing field focus', () => {
  assert.match(sheetSource, /useVisualViewportOverlayStyle\(open\)/u);
  assert.match(sheetSource, /style=\{overlayStyle\}/u);
  assert.match(sheetSource, /panelRef\.current\?\.contains\(activeElement\)/u);
  assert.match(sheetSource, /activeElement !== closeButtonRef\.current/u);
  assert.doesNotMatch(sheetCss, /min\(var\(--app-keyboard-overlap/u);
});

test('publication buttons are edge-to-edge on phones without a fake drag affordance', () => {
  assert.doesNotMatch(sheetSource, /publication-buttons-sheet__grabber/u);
  assert.match(
    sheetCss,
    /@media \(max-width: 520px\) \{[\s\S]*?\.publication-buttons-sheet \{\s*padding: 0;/u,
  );
  assert.match(sheetCss, /\.publication-buttons-sheet__panel \{[\s\S]*?max-height: 100%;/u);
});

test('additional publication buttons require an intentional visible name', () => {
  assert.match(sheetSource, /text: nextIndex === 0 \? nextButton\.text : ''/u);
  assert.match(sheetSource, /placeholder=\{index === 0 \? 'Открыть' : 'Название кнопки'\}/u);
});
