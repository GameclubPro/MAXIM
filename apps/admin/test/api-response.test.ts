import assert from 'node:assert/strict';
import test from 'node:test';
import { readJsonResponse } from '../src/api-response';

function createResponse(options: {
  ok: boolean;
  status: number;
  text: string;
  contentType?: string | null;
}): Response {
  return {
    ok: options.ok,
    status: options.status,
    headers: {
      get(name: string) {
        return name.toLowerCase() === 'content-type' ? (options.contentType ?? null) : null;
      },
    } as Headers,
    text: async () => options.text,
  } as Response;
}

test('keeps auth status errors when the API returns non-JSON HTML', async () => {
  await assert.rejects(
    () =>
      readJsonResponse(
        createResponse({
          ok: false,
          status: 401,
          text: '<html>Unauthorized</html>',
          contentType: 'text/html',
        }),
      ),
    /Ошибка API: 401/u,
  );
});

test('reads JSON API error messages before falling back to status', async () => {
  await assert.rejects(
    () =>
      readJsonResponse(
        createResponse({
          ok: false,
          status: 403,
          text: JSON.stringify({ message: ['Нет доступа', 'Basic Auth required'] }),
          contentType: 'application/json; charset=utf-8',
        }),
      ),
    /Нет доступа; Basic Auth required/u,
  );
});

test('rejects successful non-JSON responses as invalid API payloads', async () => {
  await assert.rejects(
    () =>
      readJsonResponse(
        createResponse({
          ok: true,
          status: 200,
          text: '<html>Admin login</html>',
          contentType: 'text/html',
        }),
      ),
    /некорректный ответ/u,
  );
});

test('parses successful JSON responses', async () => {
  const payload = await readJsonResponse(
    createResponse({
      ok: true,
      status: 200,
      text: JSON.stringify({ ok: true }),
      contentType: 'application/json',
    }),
  );

  assert.deepEqual(payload, { ok: true });
});
