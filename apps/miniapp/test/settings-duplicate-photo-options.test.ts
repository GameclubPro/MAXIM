import assert from 'node:assert/strict';
import test from 'node:test';
import { DUPLICATE_PHOTO_MODERATION_HINTS } from '../src/pages/settings/settings-duplicate-photo-options';
import {
  formatDuplicatePhotoCardStatus,
  formatDuplicatePhotoCoverageLabel,
} from '../src/pages/settings/settings-duplicate-photo-status';

test('photo duplicate presentation distinguishes all effective rollout modes', () => {
  assert.equal(formatDuplicatePhotoCoverageLabel('Похожие', 'OFF'), 'Похожие • фото неактивно');
  assert.equal(
    formatDuplicatePhotoCoverageLabel('Похожие', 'OBSERVE'),
    'Похожие • фото: наблюдение',
  );
  assert.equal(
    formatDuplicatePhotoCoverageLabel('Похожие', 'DELETE_ONLY'),
    'Похожие • фото: удаление',
  );
  assert.equal(formatDuplicatePhotoCoverageLabel('Похожие', 'FULL'), 'Похожие + фото');

  assert.equal(formatDuplicatePhotoCardStatus('OFF'), 'Фото: неактивно');
  assert.equal(formatDuplicatePhotoCardStatus('OBSERVE'), 'Фото: наблюдение');
  assert.equal(formatDuplicatePhotoCardStatus('DELETE_ONLY'), 'Фото: удаление');
  assert.equal(formatDuplicatePhotoCardStatus('FULL'), 'Текст + фото');
});

test('photo duplicate rollout hints do not promise unavailable actions', () => {
  assert.match(DUPLICATE_PHOTO_MODERATION_HINTS.OFF, /фото не проверяются/);
  assert.match(DUPLICATE_PHOTO_MODERATION_HINTS.OBSERVE, /Фото не удаляются/);
  assert.match(DUPLICATE_PHOTO_MODERATION_HINTS.OBSERVE, /мут и бан не применяются/);
  assert.match(DUPLICATE_PHOTO_MODERATION_HINTS.DELETE_ONLY, /Повторные фото удаляются/);
  assert.match(DUPLICATE_PHOTO_MODERATION_HINTS.DELETE_ONLY, /мут и бан для фото не применяются/);
  assert.match(
    DUPLICATE_PHOTO_MODERATION_HINTS.FULL,
    /могут применяться по общей лестнице повторов/,
  );
});
