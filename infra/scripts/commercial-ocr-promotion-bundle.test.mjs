import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  buildCommercialOcrPromotionBundle,
  MAX_COMMERCIAL_OCR_CERTIFICATION_BYTES,
  MAX_COMMERCIAL_OCR_COHORT_BYTES,
  parseCommercialOcrPromotionBundle,
} from './commercial-ocr-promotion-bundle.mjs';

const helperPath = resolve(import.meta.dirname, 'commercial-ocr-promotion-bundle.mjs');

test('round-trips certification and cohort bytes without delimiters or normalization', () => {
  const certification = Buffer.from('{"schemaVersion":1}\n\0private', 'utf8');
  const cohort = Buffer.from('100\n200\n# reviewed\n', 'utf8');
  const parsed = parseCommercialOcrPromotionBundle(
    buildCommercialOcrPromotionBundle(certification, cohort),
  );
  assert.deepEqual(parsed.certification, certification);
  assert.deepEqual(parsed.cohort, cohort);
});

test('rejects empty, oversized, truncated, extended and malformed bundles', () => {
  assert.throws(() => buildCommercialOcrPromotionBundle(Buffer.alloc(0), Buffer.from('1')));
  assert.throws(() =>
    buildCommercialOcrPromotionBundle(
      Buffer.alloc(MAX_COMMERCIAL_OCR_CERTIFICATION_BYTES + 1),
      Buffer.from('1'),
    ),
  );
  assert.throws(() =>
    buildCommercialOcrPromotionBundle(
      Buffer.from('{}'),
      Buffer.alloc(MAX_COMMERCIAL_OCR_COHORT_BYTES + 1),
    ),
  );
  const valid = buildCommercialOcrPromotionBundle(Buffer.from('{}'), Buffer.from('1\n'));
  assert.throws(() => parseCommercialOcrPromotionBundle(valid.subarray(0, valid.length - 1)));
  assert.throws(() => parseCommercialOcrPromotionBundle(Buffer.concat([valid, Buffer.from('x')])));
  assert.throws(() => parseCommercialOcrPromotionBundle(Buffer.from('bad\n')));
  const highBitMagic = Buffer.from(valid);
  highBitMagic[0] |= 0x80;
  assert.throws(() => parseCommercialOcrPromotionBundle(highBitMagic), /header is invalid/u);
});

test('CLI pack and unpack use exclusive private files and reject trailing input', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'maxim-ocr-promotion-bundle.'));
  try {
    const sourceCertification = resolve(directory, 'source-certification.json');
    const sourceCohort = resolve(directory, 'source-cohort.txt');
    const targetCertification = resolve(directory, 'target-certification.json');
    const targetCohort = resolve(directory, 'target-cohort.txt');
    writeFileSync(sourceCertification, '{"kind":"certificate"}\n');
    writeFileSync(sourceCohort, '100\n200\n');

    const packed = spawnSync(
      process.execPath,
      [helperPath, 'pack', sourceCertification, sourceCohort],
      { encoding: null },
    );
    assert.equal(packed.status, 0, packed.stderr.toString());
    const unpacked = spawnSync(
      process.execPath,
      [helperPath, 'unpack', targetCertification, targetCohort],
      { input: packed.stdout, encoding: null },
    );
    assert.equal(unpacked.status, 0, unpacked.stderr.toString());
    assert.deepEqual(readFileSync(targetCertification), readFileSync(sourceCertification));
    assert.deepEqual(readFileSync(targetCohort), readFileSync(sourceCohort));

    const secondUnpack = spawnSync(
      process.execPath,
      [helperPath, 'unpack', targetCertification, targetCohort],
      { input: packed.stdout, encoding: null },
    );
    assert.notEqual(secondUnpack.status, 0);
    assert.deepEqual(readFileSync(targetCertification), readFileSync(sourceCertification));
    assert.deepEqual(readFileSync(targetCohort), readFileSync(sourceCohort));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
