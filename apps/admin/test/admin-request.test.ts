import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminRequestHeaders } from '../src/admin-request';

test('sends the access code only as a request header', () => {
  assert.deepEqual(createAdminRequestHeaders('  server-secret  '), {
    Accept: 'application/json',
    'X-Admin-Access-Code': 'server-secret',
  });
});

test('adds the JSON content type only for requests with JSON bodies', () => {
  assert.deepEqual(createAdminRequestHeaders('server-secret', { json: true }), {
    Accept: 'application/json',
    'X-Admin-Access-Code': 'server-secret',
    'Content-Type': 'application/json',
  });
});
