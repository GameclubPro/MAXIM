'use strict';

const MAX_BODY_BYTES = 256 * 1024;

async function readBoundedResponseBody(response, maxBytes = MAX_BODY_BYTES) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('Media readiness body is oversized.');
  }
  if (!response.body) return '';

  const chunks = [];
  const reader = response.body.getReader();
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('Media readiness body is oversized.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

function summarizeMediaHealth(httpStatus, raw) {
  const body = raw && typeof raw.message === 'object' && raw.message !== null ? raw.message : raw;
  const ocr = body?.checks?.ocr ?? {};
  const workers = ocr.workers ?? {};
  const counters = ocr.counters ?? {};
  const identity = ocr.behaviorIdentity ?? {};
  const number = (candidate, fallback = -1) =>
    typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : fallback;
  const healthy =
    Number.isInteger(httpStatus) &&
    httpStatus >= 200 &&
    httpStatus < 300 &&
    body?.ok === true &&
    ocr.ready === true;
  return {
    healthy,
    line: [
      `media-analysis status=${httpStatus}`,
      `ok=${body?.ok === true}`,
      `db=${body?.checks?.database === true}`,
      `redis=${body?.checks?.redis === true}`,
      `ocr=${ocr.ready === true}/${typeof ocr.state === 'string' ? ocr.state : 'unknown'}`,
      `workers=${number(workers.configured)}/${number(workers.live)}/${number(workers.ready)}/${number(workers.busy)}`,
      `nativeQueue=${number(ocr.queueDepth)}`,
      `failed=${number(counters.failed)}`,
      `restarts=${number(counters.restarts)}`,
      `recycles=${number(counters.recycles)}`,
      `identity=${identity.verified === true}/${typeof identity.state === 'string' ? identity.state : 'unknown'}`,
    ].join(' '),
  };
}

async function main() {
  try {
    const response = await fetch('http://127.0.0.1:3001/api/health/ready', {
      signal: AbortSignal.timeout(3_000),
    });
    const text = await readBoundedResponseBody(response);
    const summary = summarizeMediaHealth(response.status, JSON.parse(text));
    process.stdout.write(`${summary.line}\n`);
    if (!summary.healthy) process.exitCode = 1;
  } catch {
    process.stdout.write('media-analysis status=unavailable ok=false ocr=false/unknown\n');
    process.exitCode = 1;
  }
}

module.exports = { MAX_BODY_BYTES, readBoundedResponseBody, summarizeMediaHealth };

if (require.main === module || __filename === '[stdin]') {
  void main();
}
