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
