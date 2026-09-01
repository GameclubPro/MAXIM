'use strict';

const MAX_BODY_BYTES = 256 * 1024;
const INGRESS_READY_URL = 'http://127.0.0.1:3001/api/health/ready';
const ADMIN_READY_URL = 'http://127.0.0.1:3002/api/health/ready';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unwrapHealthBody(raw) {
  if (!isRecord(raw)) return {};
  return isRecord(raw.message) ? raw.message : raw;
}

function httpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? String(value) : 'unavailable';
}

function isSuccessfulStatus(value) {
  return Number.isInteger(value) && value >= 200 && value < 300;
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 'unknown';
}

function isSafeToken(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value);
}

function safeToken(value) {
  return isSafeToken(value) ? value : 'unknown';
}

async function readBoundedResponseBody(response, maxBytes = MAX_BODY_BYTES) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('Readiness body is oversized.');
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
      throw new Error('Readiness body is oversized.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

async function probeReadyEndpoint(url) {
  let response;
  try {
    response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { httpStatus: null, body: null };
  }

  try {
    const text = await readBoundedResponseBody(response);
    return { httpStatus: response.status, body: JSON.parse(text) };
  } catch {
    return { httpStatus: response.status, body: null };
  }
}

function summarizeReadyHealth(readyProbe, adminProbe) {
  const ready = unwrapHealthBody(readyProbe?.body);
  const adminReady = unwrapHealthBody(adminProbe?.body);
  const readyChecks = isRecord(ready.checks) ? ready.checks : {};
  const adminChecks = isRecord(adminReady.checks) ? adminReady.checks : {};
  const queueLag = isRecord(readyChecks.queueLag) ? readyChecks.queueLag : {};
  const systemMode = isRecord(ready.systemMode) ? ready.systemMode : {};
  const bots = isRecord(ready.bots) ? Object.values(ready.bots) : [];
  const botsWithRecentFailedEvents = bots.filter(
    (bot) => isRecord(bot) && typeof bot.failedEvents === 'number' && bot.failedEvents > 0,
  ).length;
  const mode =
    systemMode.mode === 'normal' || systemMode.mode === 'degrade' ? systemMode.mode : 'unknown';
  const queueLagSec = finiteNonNegative(systemMode.queueLagSec ?? queueLag.effectiveLagSec);
  const softWarningCodeValid =
    queueLag.softWarning === true
      ? isSafeToken(queueLag.softWarningCode)
      : queueLag.softWarning === false && queueLag.softWarningCode === null;
  const readySchemaValid =
    typeof ready.ok === 'boolean' &&
    isRecord(ready.checks) &&
    typeof readyChecks.database === 'boolean' &&
    typeof readyChecks.redis === 'boolean' &&
    isRecord(readyChecks.queueLag) &&
    typeof queueLag.ok === 'boolean' &&
    typeof queueLag.rawOk === 'boolean' &&
    typeof queueLag.softWarning === 'boolean' &&
    softWarningCodeValid &&
    isRecord(ready.systemMode) &&
    mode !== 'unknown' &&
    typeof systemMode.degraded === 'boolean' &&
    systemMode.degraded === (mode === 'degrade') &&
    queueLagSec !== 'unknown' &&
    isRecord(ready.bots);
  const adminSchemaValid =
    typeof adminReady.ok === 'boolean' &&
    isRecord(adminReady.checks) &&
    typeof adminChecks.database === 'boolean' &&
    typeof adminChecks.redis === 'boolean';
  const summary = {
    readyHttpOk: isSuccessfulStatus(readyProbe?.httpStatus),
    readyStatus: httpStatus(readyProbe?.httpStatus),
    readySchemaValid,
    ok: ready.ok === true,
    mode,
    degraded: systemMode.degraded === true || mode === 'degrade',
    queueLagSec,
    queueLagOk: queueLag.ok === true,
    database: readyChecks.database === true,
    redis: readyChecks.redis === true,
    adminHttpOk: isSuccessfulStatus(adminProbe?.httpStatus),
    adminStatus: httpStatus(adminProbe?.httpStatus),
    adminSchemaValid,
    adminReady: adminReady.ok === true,
    adminDatabase: adminChecks.database === true,
    adminRedis: adminChecks.redis === true,
    softWarning: queueLag.softWarning === true,
    softWarningCode: queueLag.softWarning === true ? safeToken(queueLag.softWarningCode) : 'none',
    rawOk: typeof queueLag.rawOk === 'boolean' ? String(queueLag.rawOk) : 'unknown',
    bots: bots.length,
    botsWithRecentFailedEvents,
  };
  const healthy =
    summary.readyHttpOk &&
    summary.readySchemaValid &&
    summary.ok &&
    summary.database &&
    summary.redis &&
    summary.queueLagOk &&
    summary.adminHttpOk &&
    summary.adminSchemaValid &&
    summary.adminReady &&
    summary.adminDatabase &&
    summary.adminRedis;
  const lines = [
    [
      `ready ok=${summary.ok}`,
      `status=${summary.readyStatus}`,
      `schema=${summary.readySchemaValid}`,
      `mode=${summary.mode}`,
      `degraded=${summary.degraded}`,
      `queueLagSec=${summary.queueLagSec}`,
      `queueOk=${summary.queueLagOk}`,
      `db=${summary.database}`,
      `redis=${summary.redis}`,
      `apiAdminReady=${summary.adminReady}`,
      `apiAdminStatus=${summary.adminStatus}`,
      `apiAdminSchema=${summary.adminSchemaValid}`,
      `apiAdminDb=${summary.adminDatabase}`,
      `apiAdminRedis=${summary.adminRedis}`,
      `softWarning=${summary.softWarning}`,
      `softWarningCode=${summary.softWarningCode}`,
      `rawOk=${summary.rawOk}`,
      `bots=${summary.bots}`,
      `botsWithRecentFailedEvents=${summary.botsWithRecentFailedEvents}`,
    ].join(' '),
  ];

  if (!summary.readyHttpOk) {
    lines.push(`WARN: ingress ready status=${summary.readyStatus}`);
  }
  if (!summary.readySchemaValid) {
    lines.push('WARN: ingress ready payload is invalid');
  }
  if (summary.degraded) {
    lines.push(`WARN: system mode degraded (${summary.mode})`);
  }
  if (!summary.database) {
    lines.push('WARN: database check is not true');
  }
  if (!summary.redis) {
    lines.push('WARN: redis check is not true');
  }
  if (
    !summary.adminHttpOk ||
    !summary.adminSchemaValid ||
    !summary.adminReady ||
    !summary.adminDatabase ||
    !summary.adminRedis
  ) {
    lines.push(`WARN: api-admin ready check failed (status=${summary.adminStatus})`);
  }
  if (summary.softWarning) {
    lines.push(`WARN: queue lag soft warning: ${summary.softWarningCode}`);
  }
  if (summary.rawOk !== 'true') {
    lines.push(`WARN: queue metrics rawOk=${summary.rawOk}`);
  }

  return { healthy, lines };
}

async function runReadyMonitor({ probe = probeReadyEndpoint, writeLine = console.log } = {}) {
  const [readyProbe, adminProbe] = await Promise.all([
    probe(INGRESS_READY_URL),
    probe(ADMIN_READY_URL),
  ]);
  const summary = summarizeReadyHealth(readyProbe, adminProbe);
  for (const line of summary.lines) {
    writeLine(line);
  }
  return summary.healthy ? 0 : 1;
}

module.exports = {
  ADMIN_READY_URL,
  INGRESS_READY_URL,
  MAX_BODY_BYTES,
  probeReadyEndpoint,
  readBoundedResponseBody,
  runReadyMonitor,
  summarizeReadyHealth,
};

if (require.main === module || __filename === '[stdin]') {
  void runReadyMonitor()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      process.stdout.write(
        'ready ok=false status=unavailable schema=false mode=unknown degraded=false ' +
          'queueLagSec=unknown queueOk=false db=false redis=false apiAdminReady=false ' +
          'apiAdminStatus=unavailable apiAdminSchema=false apiAdminDb=false ' +
          'apiAdminRedis=false softWarning=false softWarningCode=none ' +
          'rawOk=unknown bots=0 botsWithRecentFailedEvents=0\n',
      );
      process.exitCode = 1;
    });
}
