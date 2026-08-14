#!/usr/bin/env node

import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BUNDLE_MAGIC = 'MAXIM-COMMERCIAL-OCR-PROMOTION/1';
export const MAX_COMMERCIAL_OCR_CERTIFICATION_BYTES = 256 * 1024;
export const MAX_COMMERCIAL_OCR_COHORT_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 128;

export function buildCommercialOcrPromotionBundle(certification, cohort) {
  const certificationBytes = validatePayload(
    certification,
    'Certification',
    MAX_COMMERCIAL_OCR_CERTIFICATION_BYTES,
  );
  const cohortBytes = validatePayload(cohort, 'Cohort', MAX_COMMERCIAL_OCR_COHORT_BYTES);
  const header = Buffer.from(
    `${BUNDLE_MAGIC} ${certificationBytes.byteLength} ${cohortBytes.byteLength}\n`,
    'ascii',
  );
  return Buffer.concat([header, certificationBytes, cohortBytes]);
}

export function parseCommercialOcrPromotionBundle(bundle) {
  if (!Buffer.isBuffer(bundle)) {
    throw new Error('Promotion bundle must be a buffer.');
  }
  const newlineIndex = bundle.indexOf(0x0a);
  if (newlineIndex < 0 || newlineIndex + 1 > MAX_HEADER_BYTES) {
    throw new Error('Promotion bundle header is invalid.');
  }
  const headerBytes = bundle.subarray(0, newlineIndex);
  if (headerBytes.some((byte) => byte < 0x20 || byte > 0x7e)) {
    throw new Error('Promotion bundle header is invalid.');
  }
  const header = headerBytes.toString('ascii');
  const match = /^MAXIM-COMMERCIAL-OCR-PROMOTION\/1 ([1-9][0-9]*) ([1-9][0-9]*)$/u.exec(header);
  if (!match) {
    throw new Error('Promotion bundle header is invalid.');
  }
  const certificationLength = Number(match[1]);
  const cohortLength = Number(match[2]);
  if (
    !Number.isSafeInteger(certificationLength) ||
    certificationLength > MAX_COMMERCIAL_OCR_CERTIFICATION_BYTES ||
    !Number.isSafeInteger(cohortLength) ||
    cohortLength > MAX_COMMERCIAL_OCR_COHORT_BYTES
  ) {
    throw new Error('Promotion bundle payload length is invalid.');
  }
  const payloadOffset = newlineIndex + 1;
  const expectedLength = payloadOffset + certificationLength + cohortLength;
  if (bundle.byteLength !== expectedLength) {
    throw new Error('Promotion bundle length does not match its header.');
  }
  return Object.freeze({
    certification: Buffer.from(bundle.subarray(payloadOffset, payloadOffset + certificationLength)),
    cohort: Buffer.from(bundle.subarray(payloadOffset + certificationLength)),
  });
}

function validatePayload(value, label, maximumBytes) {
  if (!Buffer.isBuffer(value) || value.byteLength < 1 || value.byteLength > maximumBytes) {
    throw new Error(`${label} payload size is invalid.`);
  }
  return value;
}

function readBoundedFile(path, maximumBytes, label) {
  const metadata = statSync(path);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumBytes) {
    throw new Error(`${label} file size is invalid.`);
  }
  return readFileSync(path);
}

async function readBoundedStdin() {
  const maximumBytes =
    MAX_HEADER_BYTES + MAX_COMMERCIAL_OCR_CERTIFICATION_BYTES + MAX_COMMERCIAL_OCR_COHORT_BYTES;
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.byteLength;
    if (totalBytes > maximumBytes) {
      throw new Error('Promotion bundle exceeds the transfer limit.');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, totalBytes);
}

async function unpackToFiles(certificationPath, cohortPath) {
  const certificationTarget = resolve(certificationPath);
  const cohortTarget = resolve(cohortPath);
  if (certificationTarget === cohortTarget) {
    throw new Error('Promotion bundle targets must be distinct.');
  }
  const payload = parseCommercialOcrPromotionBundle(await readBoundedStdin());
  let certificationCreated = false;
  let cohortCreated = false;
  try {
    writeFileSync(certificationTarget, payload.certification, { flag: 'wx', mode: 0o600 });
    certificationCreated = true;
    writeFileSync(cohortTarget, payload.cohort, { flag: 'wx', mode: 0o600 });
    cohortCreated = true;
  } catch (error) {
    if (certificationCreated) rmSync(certificationTarget, { force: true });
    if (cohortCreated) rmSync(cohortTarget, { force: true });
    throw error;
  }
}

async function main(argv) {
  const [command, firstPath, secondPath] = argv;
  if (!firstPath || !secondPath || argv.length !== 3) {
    throw new Error('Usage: commercial-ocr-promotion-bundle.mjs <pack|unpack> <first> <second>');
  }
  if (command === 'pack') {
    const certification = readBoundedFile(
      firstPath,
      MAX_COMMERCIAL_OCR_CERTIFICATION_BYTES,
      'Certification',
    );
    const cohort = readBoundedFile(secondPath, MAX_COMMERCIAL_OCR_COHORT_BYTES, 'Cohort');
    process.stdout.write(buildCommercialOcrPromotionBundle(certification, cohort));
    return;
  }
  if (command === 'unpack') {
    await unpackToFiles(firstPath, secondPath);
    return;
  }
  throw new Error('Usage: commercial-ocr-promotion-bundle.mjs <pack|unpack> <first> <second>');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  void main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Promotion bundle failed.'}\n`,
    );
    process.exitCode = 1;
  });
}
