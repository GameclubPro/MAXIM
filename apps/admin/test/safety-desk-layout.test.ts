import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('stacks the Safety Desk metrics before a 1440px viewport can clip topbar actions', () => {
  const mediaStarts = Array.from(styles.matchAll(/@media \(max-width: (\d+)px\) \{/gu));
  const responsiveTopbar = mediaStarts
    .map((match, index) => {
      const start = match.index;
      const end = mediaStarts[index + 1]?.index ?? styles.length;
      return {
        maxWidth: Number(match[1]),
        source: styles.slice(start, end),
      };
    })
    .find(
      ({ source }) =>
        source.includes('grid-template-columns: minmax(180px, 1fr) auto auto;') &&
        source.includes('grid-column: 1 / -1;') &&
        source.includes('grid-template-rows: auto minmax(0, 1fr);'),
    );

  assert.ok(responsiveTopbar);
  assert.ok(responsiveTopbar.maxWidth >= 1440);
  assert.ok(responsiveTopbar.maxWidth <= 1600);
});
