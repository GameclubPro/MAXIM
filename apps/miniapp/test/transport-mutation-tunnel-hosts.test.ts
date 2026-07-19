import assert from 'node:assert/strict';
import test from 'node:test';
import { isMutationTunnelPreferredHost } from '../src/lib/api/transport-mutation-tunnel-hosts';

test('mutation tunnel host matching accepts only exact preferred hostnames', () => {
  assert.equal(isMutationTunnelPreferredHost('https://api-cdn.flex-craft.ru/api/v1'), true);
  assert.equal(isMutationTunnelPreferredHost('https://api2.major-maksimov.ru/api/v1'), true);
  assert.equal(
    isMutationTunnelPreferredHost('https://api-cdn.flex-craft.ru.attacker.example/api/v1'),
    false,
  );
  assert.equal(
    isMutationTunnelPreferredHost('https://attacker.example/api-cdn.flex-craft.ru/api/v1'),
    false,
  );
});

test('mutation tunnel host matching fails closed for malformed URLs', () => {
  assert.equal(isMutationTunnelPreferredHost('https://[api-cdn.flex-craft.ru'), false);
  assert.equal(isMutationTunnelPreferredHost('http://[::1'), false);
});
