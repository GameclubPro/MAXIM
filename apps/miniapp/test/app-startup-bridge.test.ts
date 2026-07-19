import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8');

test('native environment refresh promotes init data discovered after the quick startup wait', () => {
  assert.match(
    appSource,
    /const discoveredInitData = getInitData\(\);[\s\S]{0,240}?currentInitData === discoveredInitData \? currentInitData : discoveredInitData/u,
  );
  assert.match(appSource, /readMaxNativeEnvironmentSignature\(discoveredInitData \|\| initData\)/u);
});

test('late bridge data replaces stale URL fallback state instead of splitting the session', () => {
  assert.doesNotMatch(
    appSource,
    /setInitData\(\(currentInitData\) => currentInitData \|\| discoveredInitData\)/u,
  );
});

test('late bridge discovery remains wired to script load and removes the listener on cleanup', () => {
  assert.match(
    appSource,
    /maxBridgeScript\?\.addEventListener\('load', refreshNativeEnvironmentSignature\);/u,
  );
  assert.match(
    appSource,
    /maxBridgeScript\?\.removeEventListener\('load', refreshNativeEnvironmentSignature\);/u,
  );
});
