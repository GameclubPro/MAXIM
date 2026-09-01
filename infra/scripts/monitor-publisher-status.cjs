'use strict';

const { readFileSync } = require('node:fs');

const PAUSE_KINDS = new Set(['missing', 'unknown', 'authorization', 'operator']);
const HEARTBEAT_KINDS = new Set(['missing', 'invalid', 'fresh']);

function parseExpected(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('Publisher dispatch expectation is invalid.');
}

function summarizePublisherStatus(
  control,
  adminExpectedRaw,
  publisherExpectedRaw,
  botIdParityRaw,
) {
  const adminExpected = parseExpected(adminExpectedRaw);
  const publisherExpected = parseExpected(publisherExpectedRaw);
  const botIdParity = parseExpected(botIdParityRaw);
  if (
    !control ||
    typeof control !== 'object' ||
    Array.isArray(control) ||
    control.result !== 'observed' ||
    !PAUSE_KINDS.has(control.pauseKind) ||
    !HEARTBEAT_KINDS.has(control.heartbeatKind) ||
    (control.heartbeatEnabled !== null && typeof control.heartbeatEnabled !== 'boolean')
  ) {
    throw new Error('Publisher runtime status is invalid.');
  }

  const parity = adminExpected === publisherExpected;
  const healthy =
    parity &&
    botIdParity &&
    control.pauseKind === 'missing' &&
    control.heartbeatKind === 'fresh' &&
    control.heartbeatEnabled === publisherExpected;
  return {
    healthy,
    line: [
      `publisher expected=${publisherExpected}`,
      `parity=${parity}`,
      `botParity=${botIdParity}`,
      `pause=${control.pauseKind}`,
      `heartbeat=${control.heartbeatKind}/${String(control.heartbeatEnabled)}`,
    ].join(' '),
  };
}

function main() {
  const input = readFileSync(0, 'utf8');
  if (Buffer.byteLength(input, 'utf8') > 16 * 1024) {
    throw new Error('Publisher runtime status is oversized.');
  }
  const summary = summarizePublisherStatus(
    JSON.parse(input),
    process.argv[2],
    process.argv[3],
    process.argv[4],
  );
  process.stdout.write(`${summary.line}\n`);
  if (!summary.healthy) process.exitCode = 1;
}

module.exports = { summarizePublisherStatus };

if (require.main === module) {
  try {
    main();
  } catch {
    process.stderr.write('Publisher runtime status parsing failed closed.\n');
    process.exitCode = 2;
  }
}
