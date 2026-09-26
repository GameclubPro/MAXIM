import assert from 'node:assert/strict';
import test from 'node:test';
import presets from '../src/lib/preview-device-presets.json' with { type: 'json' };
import { resolveCaptureDevice } from '../../../scripts/miniapp-smartphone.mjs';

test('smartphone capture uses the OS engine and screen less host chrome, without Safari bars', () => {
  const iphone = resolveCaptureDevice(presets.iphone);
  assert.equal(iphone.browserName, 'webkit');
  assert.deepEqual(iphone.contextOptions.screen, { width: 393, height: 852 });
  assert.deepEqual(iphone.contextOptions.viewport, { width: 393, height: 749 });
  assert.equal(iphone.profile.safeTop, 0);
  assert.equal(iphone.profile.safeBottom, 34);
  assert.equal(iphone.contextOptions.deviceScaleFactor, 3);
  assert.equal(iphone.contextOptions.isMobile, true);
  assert.equal(iphone.contextOptions.hasTouch, true);
  const android = resolveCaptureDevice(presets.android);
  assert.equal(android.browserName, 'chromium');
  assert.deepEqual(android.contextOptions.viewport, { width: 412, height: 811 });
  const small = resolveCaptureDevice(presets['iphone-se']);
  assert.deepEqual(small.contextOptions.viewport, { width: 320, height: 504 });
  assert.equal(small.contextOptions.deviceScaleFactor, 2);
});

test('measured host geometry can be calibrated without changing app CSS or preview presets', () => {
  const original = structuredClone(presets.iphone);
  const capture = resolveCaptureDevice(presets.iphone, {
    metrics: { iphone: { height: 844, headerHeight: 52, statusBarHeight: 47 } },
  });
  assert.deepEqual(capture.contextOptions.viewport, { width: 393, height: 745 });
  assert.equal(capture.phone.calibrated, true);
  assert.deepEqual(presets.iphone, original);
  for (const metrics of [
    { headerHeight: -1 },
    { headerHeight: 0.5 },
    { height: 100 },
    { mystery: 10 },
  ]) {
    assert.throws(() => resolveCaptureDevice(presets.iphone, { metrics: { iphone: metrics } }));
  }
});

test('legacy capture remains available with an explicit engine override and no phone composition', () => {
  const legacy = resolveCaptureDevice(presets.iphone, { target: 'native' });
  assert.equal(legacy.browserName, 'chromium');
  assert.deepEqual(legacy.contextOptions.viewport, { width: 393, height: 659 });
  assert.equal(legacy.phone, null);
  assert.equal(resolveCaptureDevice(presets.android, { engine: 'webkit' }).browserName, 'webkit');
  assert.throws(() => resolveCaptureDevice(presets.iphone, { engine: 'unknown' }));
});
