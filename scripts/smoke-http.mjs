#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const timeoutMs = Number(process.env.MAXIM_SMOKE_TIMEOUT_MS || 20_000);

export async function fetchChecked(url, options = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    ...options,
  });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}.`);
  }
  return response;
}

export async function smokeJsonOk(url) {
  const response = await fetchChecked(url, { headers: { accept: 'application/json' } });
  const payload = await response.json();
  if (payload?.ok !== true) {
    throw new Error(`${url} did not return JSON with ok === true.`);
  }
  return payload;
}

export function findStaticAssets(html, pageUrl) {
  const assets = { js: [], css: [] };
  for (const match of html.matchAll(
    /<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/giu,
  )) {
    const assetUrl = new URL(match[1], pageUrl).href;
    const pathname = new URL(assetUrl).pathname;
    if (/\.js$/u.test(pathname)) {
      assets.js.push(assetUrl);
    } else if (/\.css$/u.test(pathname)) {
      assets.css.push(assetUrl);
    }
  }
  return { js: [...new Set(assets.js)], css: [...new Set(assets.css)] };
}

export async function smokeStaticSite(url, marker = 'id="root"') {
  const response = await fetchChecked(url, { headers: { accept: 'text/html' } });
  const html = await response.text();
  if (!html.includes(marker)) {
    throw new Error(`${url} HTML is missing marker ${marker}.`);
  }
  const assets = findStaticAssets(html, response.url || url);
  if (assets.js.length === 0 || assets.css.length === 0) {
    throw new Error(`${url} must reference at least one JavaScript and one CSS asset.`);
  }
  await Promise.all([fetchChecked(assets.js[0]), fetchChecked(assets.css[0])]);
  return assets;
}

async function runCli(argv) {
  const [mode, url, marker] = argv;
  if (mode === 'json-ok' && url) {
    await smokeJsonOk(url);
  } else if (mode === 'static' && url) {
    await smokeStaticSite(url, marker);
  } else {
    throw new Error('Usage: smoke-http.mjs json-ok <url> | static <url> [marker]');
  }
  process.stdout.write(`Smoke passed: ${url}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
