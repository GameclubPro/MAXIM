#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const BLOCKING_SEVERITIES = Object.freeze(['critical', 'high']);
const PAGE_SIZE = 100;
const MAX_PAGES_PER_SEVERITY = 100;

function requireValue(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${name} is required to verify CodeQL alerts.`);
  }
  return normalized;
}

function assertRepository(value) {
  const repository = requireValue(value, 'GITHUB_REPOSITORY');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(`Invalid GITHUB_REPOSITORY: ${repository}`);
  }
  return repository;
}

async function readResponseJson(response, requestUrl) {
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `GitHub code-scanning API failed with HTTP ${response.status} for ${requestUrl}: ${detail.slice(0, 500)}`,
    );
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error(`GitHub code-scanning API returned a non-array payload for ${requestUrl}.`);
  }
  return payload;
}

export async function listBlockingCodeqlAlerts({
  repository,
  ref,
  token,
  fetchImpl = globalThis.fetch,
}) {
  const exactRepository = assertRepository(repository);
  const exactRef = requireValue(ref, 'GITHUB_REF');
  const exactToken = requireValue(token, 'GITHUB_TOKEN');
  if (typeof fetchImpl !== 'function') {
    throw new Error('A Fetch implementation is required to verify CodeQL alerts.');
  }

  const alerts = [];
  for (const severity of BLOCKING_SEVERITIES) {
    for (let page = 1; page <= MAX_PAGES_PER_SEVERITY; page += 1) {
      const requestUrl = new URL(
        `https://api.github.com/repos/${exactRepository}/code-scanning/alerts`,
      );
      requestUrl.searchParams.set('state', 'open');
      requestUrl.searchParams.set('severity', severity);
      requestUrl.searchParams.set('ref', exactRef);
      requestUrl.searchParams.set('per_page', String(PAGE_SIZE));
      requestUrl.searchParams.set('page', String(page));
      const response = await fetchImpl(requestUrl, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${exactToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      const pageAlerts = await readResponseJson(response, requestUrl);
      alerts.push(...pageAlerts);
      if (pageAlerts.length < PAGE_SIZE) {
        break;
      }
      if (page === MAX_PAGES_PER_SEVERITY) {
        throw new Error(`CodeQL alert pagination exceeded ${MAX_PAGES_PER_SEVERITY} pages.`);
      }
    }
  }
  return alerts;
}

export async function assertExactCodeqlAnalysis({
  repository,
  ref,
  sha,
  token,
  fetchImpl = globalThis.fetch,
}) {
  const exactRepository = assertRepository(repository);
  const exactRef = requireValue(ref, 'GITHUB_REF');
  const exactSha = requireValue(sha, 'GITHUB_SHA');
  const exactToken = requireValue(token, 'GITHUB_TOKEN');
  const requestUrl = new URL(
    `https://api.github.com/repos/${exactRepository}/code-scanning/analyses`,
  );
  requestUrl.searchParams.set('ref', exactRef);
  requestUrl.searchParams.set('tool_name', 'CodeQL');
  requestUrl.searchParams.set('per_page', String(PAGE_SIZE));
  const response = await fetchImpl(requestUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${exactToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  const analyses = await readResponseJson(response, requestUrl);
  const exactAnalysis = analyses.find(
    (analysis) => analysis?.commit_sha === exactSha && analysis?.ref === exactRef,
  );
  if (!exactAnalysis) {
    throw new Error(`No processed CodeQL analysis found for exact ref ${exactRef} at ${exactSha}.`);
  }
  if (exactAnalysis.error) {
    throw new Error(`CodeQL analysis for ${exactSha} reported an error: ${exactAnalysis.error}`);
  }
  return exactAnalysis;
}

export async function assertNoBlockingCodeqlAlerts(options) {
  await assertExactCodeqlAnalysis(options);
  const alerts = await listBlockingCodeqlAlerts(options);
  if (alerts.length === 0) {
    return [];
  }

  const details = alerts
    .slice(0, 20)
    .map((alert) => {
      const number = alert?.number ?? 'unknown';
      const rule = alert?.rule?.id ?? 'unknown-rule';
      const path = alert?.most_recent_instance?.location?.path ?? 'unknown-path';
      return `#${number} ${rule} (${path})`;
    })
    .join(', ');
  throw new Error(
    `CodeQL found ${alerts.length} open high/critical alert(s) on ${options.ref}: ${details}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const alerts = await assertNoBlockingCodeqlAlerts({
      repository: process.env.GITHUB_REPOSITORY,
      ref: process.env.GITHUB_REF,
      sha: process.env.GITHUB_SHA,
      token: process.env.GITHUB_TOKEN,
    });
    process.stdout.write(
      `Verified exact CodeQL analysis and 0 open high/critical alerts for ${process.env.GITHUB_SHA}.\n`,
    );
    process.exitCode = alerts.length === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
