'use strict';

const MAX_BODY_BYTES = 256 * 1024;
const OCR_READY_URL = 'http://127.0.0.1:3001/api/health/ready?scope=ocr';

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
  const terminalDeadlineExhausted = ocr.bullMqTerminalDeadlineExhaustedProcess ?? {};
  const identity = ocr.behaviorIdentity ?? {};
  const number = (candidate) =>
    typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : 'not-probed';
  const counter = (candidate) =>
    Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : 'not-probed';
  const dependency = (candidate) =>
    typeof candidate === 'boolean' ? String(candidate) : 'not-probed';
  const scope = typeof body?.scope === 'string' ? body.scope : 'full';
  const healthy =
    Number.isInteger(httpStatus) &&
    httpStatus >= 200 &&
    httpStatus < 300 &&
    scope === 'ocr' &&
    body?.ok === true &&
    ocr.ready === true;
  return {
    healthy,
    line: [
      `media-analysis status=${httpStatus}`,
      `scope=${scope}`,
      `ok=${body?.ok === true}`,
      `db=${dependency(body?.checks?.database)}`,
      `redis=${dependency(body?.checks?.redis)}`,
      `ocr=${ocr.ready === true}/${typeof ocr.state === 'string' ? ocr.state : 'unknown'}`,
      `workers=${number(workers.configured)}/${number(workers.live)}/${number(workers.ready)}/${number(workers.busy)}`,
      `nativeQueue=${number(ocr.queueDepth)}`,
      `bullMqDeadlineExhaustedProcess=source_not_ready:${counter(terminalDeadlineExhausted.source_not_ready)},governor_pressure:${counter(terminalDeadlineExhausted.governor_pressure)},admission_pending:${counter(terminalDeadlineExhausted.admission_pending)}`,
      `failed=${number(counters.failed)}`,
      `restarts=${number(counters.restarts)}`,
      `recycles=${number(counters.recycles)}`,
      `identity=${identity.verified === true}/${typeof identity.state === 'string' ? identity.state : 'unknown'}`,
    ].join(' '),
  };
}

async function main() {
  try {
    const response = await fetch(OCR_READY_URL, {
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

module.exports = { MAX_BODY_BYTES, OCR_READY_URL, readBoundedResponseBody, summarizeMediaHealth };

if (require.main === module || __filename === '[stdin]') {
  void main();
}
