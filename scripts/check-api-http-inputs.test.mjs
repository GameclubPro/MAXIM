import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import {
  assertHttpInputBoundaries,
  compareHttpInputBaseline,
  findHttpInputFindings,
} from './check-api-http-inputs.mjs';

const filename = 'apps/api/src/example.controller.ts';
function findings(parameter, body = 'return input;') {
  return findHttpInputFindings(
    `import { Query, Body, ParseIntPipe } from '@nestjs/common';
    class Example { list(${parameter}) { ${body} } }`,
    filename,
  );
}

test('raw HTTP types cannot stand in for validation, including unions and objects', () => {
  for (const parameter of [
    "@Query('cursor') input: string | undefined",
    '@Body() input: Record<string, unknown>',
    '@Query() input: any',
    '@Body() input',
  ]) {
    assert.equal(findings(parameter).length, 1, parameter);
  }
  assert.deepEqual(findings('@Query() input: unknown'), []);
  assert.deepEqual(findings('@Body() input: unknown'), []);
  assert.deepEqual(findings("@Query('limit', ParseIntPipe) input: number"), []);
  assert.deepEqual(findings("@Query('limit', new ParseIntPipe()) input: number"), []);
  assert.equal(findings("@Query('limit', new CustomPipe()) input: number").length, 1);
});

test('resolves Nest import aliases and namespaces without matching unrelated decorators', () => {
  assert.equal(
    findHttpInputFindings(
      `import {Query as Q} from '@nestjs/common'; class C { m(@Q('x') x: string) {} }`,
      filename,
    ).length,
    1,
  );
  assert.equal(
    findHttpInputFindings(
      `import * as N from '@nestjs/common'; class C { m(@N.Body() x: object) {} }`,
      filename,
    ).length,
    1,
  );
  assert.deepEqual(
    findHttpInputFindings(
      `import {Query} from 'other'; class C { m(@Query() x: string) {} }`,
      filename,
    ),
    [],
  );
});

test('legacy exceptions pin the handler, reject changed logic, and require obsolete entries removed', () => {
  const original = findings("@Query('cursor') input: string");
  const baseline = { version: 1, exceptions: original };
  assert.deepEqual(compareHttpInputBaseline(original, baseline), []);
  assert.equal(
    compareHttpInputBaseline(
      findings("@Query('cursor') input: string", 'return input.length;'),
      baseline,
    ).length,
    1,
  );
  assert.match(compareHttpInputBaseline([], baseline)[0], /obsolete/u);
  assert.throws(
    () =>
      compareHttpInputBaseline(original, { version: 1, exceptions: [...original, ...original] }),
    /Duplicate/u,
  );
});

test('repository HTTP boundaries do not expand the reviewed legacy baseline', () => {
  assertHttpInputBoundaries(resolve(import.meta.dirname, '..'));
});
