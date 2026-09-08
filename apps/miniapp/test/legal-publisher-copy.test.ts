import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('both legal documents and their shared introduction explicitly include Publik', () => {
  const source = readFileSync(new URL('../src/pages/legal-page.tsx', import.meta.url), 'utf8');
  for (const prefix of [
    'Приложение в MAX включает ботов',
    'Настоящее пользовательское соглашение и правила использования регулируют работу ботов',
    'Настоящая политика обработки персональных данных и конфиденциальности объясняет, какие данные боты',
    'Условия использования ботов',
  ]) {
    assert.match(source, new RegExp(`${prefix}[^\\n]+«Публик»`, 'u'));
  }
  assert.match(source, /Версия 1\.2\. Действует с 09\.09\.2026\./u);
});
