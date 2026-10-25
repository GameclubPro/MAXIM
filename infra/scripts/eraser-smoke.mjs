#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

export function assertEraserHealth(body, expectedSha) {
  if (!/^[a-f0-9]{40}$/u.test(expectedSha ?? ''))
    throw new Error('Lastik smoke requires an exact source SHA.');
  if (
    body?.status !== 'ok' ||
    body?.service !== 'eraser' ||
    body?.commitSha !== expectedSha ||
    typeof body?.enabled !== 'boolean'
  ) {
    throw new Error('Lastik identity or store readiness is not confirmed.');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const response = await fetch('http://127.0.0.1:3005/health', {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Lastik health request failed.');
    const body = await response.json();
    assertEraserHealth(body, process.argv[2]);
    process.stdout.write(`Lastik exact-source availability passed (enabled=${body.enabled}).\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
