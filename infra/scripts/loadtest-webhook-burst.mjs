#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..', '..');
const DEFAULT_FIXTURE_PATH = resolve(ROOT_DIR, 'infra/loadtest-fixtures/webhook-noop.json');

function parseArgs(argv) {
  const options = {
    target: 'local',
    durationSec: 30,
    rps: 10,
    concurrency: 4,
    fixturePath: DEFAULT_FIXTURE_PATH,
    allowPublic: false,
    dryRun: false,
    probeUrl: '',
    probeRps: 0,
    probeConcurrency: 1,
    probeExpectedStatuses: new Set([200, 401, 403]),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--target':
        options.target = String(next ?? '').trim().toLowerCase();
        index += 1;
        break;
      case '--duration-sec':
        options.durationSec = Number(next ?? options.durationSec);
        index += 1;
        break;
      case '--rps':
        options.rps = Number(next ?? options.rps);
        index += 1;
        break;
      case '--concurrency':
        options.concurrency = Number(next ?? options.concurrency);
        index += 1;
        break;
      case '--fixture':
        options.fixturePath = resolve(ROOT_DIR, String(next ?? '').trim());
        index += 1;
        break;
      case '--webhook-url':
        options.webhookUrl = String(next ?? '').trim();
        index += 1;
        break;
      case '--probe-url':
        options.probeUrl = String(next ?? '').trim();
        index += 1;
        break;
      case '--probe-rps':
        options.probeRps = Number(next ?? options.probeRps);
        index += 1;
        break;
      case '--probe-concurrency':
        options.probeConcurrency = Number(next ?? options.probeConcurrency);
        index += 1;
        break;
      case '--probe-expected-statuses':
        options.probeExpectedStatuses = new Set(
          String(next ?? '')
            .split(',')
            .map((value) => Number(value.trim()))
            .filter((value) => Number.isInteger(value) && value > 0),
        );
        index += 1;
        break;
      case '--allow-public':
        options.allowPublic = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  process.stdout.write(`Usage: npm run loadtest:webhook -- [options]

Options:
  --target local|public       Target ingress. Default: local
  --duration-sec <number>     Duration in seconds. Default: 30
  --rps <number>              Aggregate webhook requests per second. Default: 10
  --concurrency <number>      Number of webhook workers. Default: 4
  --fixture <path>            Repo-relative JSON fixture path.
  --webhook-url <url>         Override webhook URL directly.
  --probe-url <url>           Optional sidecar GET probe URL.
  --probe-rps <number>        Aggregate probe requests per second. Default: 0
  --probe-concurrency <n>     Number of probe workers. Default: 1
  --probe-expected-statuses   Comma-separated accepted probe statuses. Default: 200,401,403
  --allow-public              Required when --target public is used.
  --dry-run                   Print resolved config without sending traffic.
  --help                      Show this help.
`);
}

function assertPositiveNumber(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
}

function assertNonNegativeNumber(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
}

async function readEnvFile() {
  const raw = await readFile(resolve(ROOT_DIR, '.env'), 'utf8');
  const values = {};

  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

function normalizeBaseUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/u, '');
}

function redactWebhookUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length >= 5 && segments[0] === 'api' && segments[1] === 'webhook' && segments[2] === 'max') {
      segments[4] = '[redacted]';
      url.pathname = `/${segments.join('/')}`;
    }
    return url.toString();
  } catch {
    return '[redacted-webhook-url]';
  }
}

function percentile(values, ratio) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function summarizeRun(stats) {
  const latencies = stats.latenciesMs;
  const total = stats.total;
  const ok = stats.ok;
  const nonOk = total - ok;
  const avgMs =
    latencies.length > 0 ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : 0;

  return {
    total,
    ok,
    nonOk,
    avgMs,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    statusCounts: Object.fromEntries(
      [...stats.statusCounts.entries()].sort((left, right) => Number(left[0]) - Number(right[0])),
    ),
    errors: Object.fromEntries(
      [...stats.errorCounts.entries()].sort((left, right) => left[0].localeCompare(right[0])),
    ),
  };
}

async function runFixedRateWorkers({
  label,
  url,
  concurrency,
  rps,
  deadlineMs,
  sendRequest,
  isAcceptedStatus,
}) {
  if (rps <= 0) {
    return null;
  }

  const stats = {
    total: 0,
    ok: 0,
    latenciesMs: [],
    statusCounts: new Map(),
    errorCounts: new Map(),
  };

  const perWorkerIntervalMs = Math.max(1, (1000 * concurrency) / rps);
  const workers = Array.from({ length: concurrency }, (_, workerIndex) =>
    (async () => {
      let nextAtMs = Date.now() + workerIndex * Math.max(1, perWorkerIntervalMs / concurrency);

      while (Date.now() < deadlineMs) {
        const waitMs = nextAtMs - Date.now();
        if (waitMs > 0) {
          await delay(waitMs);
        }
        nextAtMs += perWorkerIntervalMs;

        if (Date.now() >= deadlineMs) {
          break;
        }

        const startedAt = Date.now();

        try {
          const response = await sendRequest();
          const latencyMs = Date.now() - startedAt;
          stats.total += 1;
          stats.latenciesMs.push(latencyMs);
          stats.statusCounts.set(
            response.status,
            (stats.statusCounts.get(response.status) ?? 0) + 1,
          );
          if (isAcceptedStatus(response.status)) {
            stats.ok += 1;
          }
        } catch (error) {
          const latencyMs = Date.now() - startedAt;
          const message = error instanceof Error ? error.message : String(error);
          stats.total += 1;
          stats.latenciesMs.push(latencyMs);
          stats.errorCounts.set(message, (stats.errorCounts.get(message) ?? 0) + 1);
        }
      }
    })(),
  );

  await Promise.all(workers);

  return {
    label,
    url,
    requestedRps: rps,
    concurrency,
    ...summarizeRun(stats),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  assertPositiveNumber(options.durationSec, 'duration-sec');
  assertPositiveNumber(options.rps, 'rps');
  assertPositiveNumber(options.concurrency, 'concurrency');
  assertNonNegativeNumber(options.probeRps, 'probe-rps');
  assertPositiveNumber(options.probeConcurrency, 'probe-concurrency');

  const env = await readEnvFile();
  const appBaseUrl = normalizeBaseUrl(env.APP_BASE_URL);
  const botId = String(env.MAX_BOT_ID ?? '').trim();
  const secretPath = String(env.MAX_WEBHOOK_SECRET_PATH ?? '').trim();
  const headerSecret = String(env.MAX_WEBHOOK_HEADER_SECRET ?? '').trim();

  if (!botId || !secretPath || !headerSecret) {
    throw new Error('Missing MAX webhook env values in .env');
  }

  const target =
    options.webhookUrl?.trim() ||
    (options.target === 'public'
      ? `${appBaseUrl}/api/webhook/max/${encodeURIComponent(botId)}/${encodeURIComponent(secretPath)}`
      : `http://127.0.0.1:3001/api/webhook/max/${encodeURIComponent(botId)}/${encodeURIComponent(secretPath)}`);

  if (options.target === 'public' && !options.allowPublic) {
    throw new Error('Public target requires --allow-public');
  }

  const fixtureRaw = await readFile(options.fixturePath, 'utf8');
  const fixture = JSON.parse(fixtureRaw);
  const probeUrl =
    options.probeUrl ||
    (options.target === 'public' && options.probeRps > 0
      ? `${appBaseUrl}/api/v1/system/metrics/queues`
      : options.probeRps > 0
        ? 'http://127.0.0.1:3002/api/v1/system/metrics/queues'
        : '');

  const runConfig = {
    target: options.target,
    webhookUrl: redactWebhookUrl(target),
    durationSec: options.durationSec,
    rps: options.rps,
    concurrency: options.concurrency,
    fixture: basename(options.fixturePath),
    probeUrl,
    probeRps: options.probeRps,
    probeConcurrency: options.probeConcurrency,
    allowPublic: options.allowPublic,
    dryRun: options.dryRun,
  };

  process.stdout.write(`${JSON.stringify(runConfig, null, 2)}\n`);

  if (options.dryRun) {
    return;
  }

  const deadlineMs = Date.now() + options.durationSec * 1000;
  const webhookSummaryPromise = runFixedRateWorkers({
    label: 'webhook',
    url: target,
    concurrency: Math.max(1, Math.trunc(options.concurrency)),
    rps: options.rps,
    deadlineMs,
    sendRequest: async () => {
      const payload = structuredClone(fixture);
      const loadTestId = randomUUID();
      payload.update_id = `synthetic-load:${loadTestId}`;
      payload.updateId = payload.update_id;
      payload.synthetic_load_test = {
        id: loadTestId,
        sentAt: new Date().toISOString(),
      };

      return fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-max-bot-api-secret': headerSecret,
        },
        body: JSON.stringify(payload),
      });
    },
    isAcceptedStatus: (status) => status >= 200 && status < 300,
  });

  const probeSummaryPromise = probeUrl
    ? runFixedRateWorkers({
        label: 'probe',
        url: probeUrl,
        concurrency: Math.max(1, Math.trunc(options.probeConcurrency)),
        rps: options.probeRps,
        deadlineMs,
        sendRequest: async () =>
          fetch(probeUrl, {
            method: 'GET',
          }),
        isAcceptedStatus: (status) => options.probeExpectedStatuses.has(status),
      })
    : Promise.resolve(null);

  const [webhookSummary, probeSummary] = await Promise.all([
    webhookSummaryPromise,
    probeSummaryPromise,
  ]);

  process.stdout.write(`${JSON.stringify({ webhook: webhookSummary, probe: probeSummary }, null, 2)}\n`);

  if (!webhookSummary || webhookSummary.nonOk > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
