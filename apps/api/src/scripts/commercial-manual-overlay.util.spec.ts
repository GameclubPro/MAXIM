import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readCommercialManualOverlayCliOptions } from './build-commercial-manual-overlay';
import {
  buildCommercialManualOverlay,
  fingerprintCommercialManualOverlayContext,
  type CommercialManualOverlayRecord,
} from './commercial-manual-overlay.util';
import { withCommercialOutputLocks } from './commercial-output-lock.util';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function corpusRecord(params: {
  text: string;
  category: 'stable_clear' | 'stable_hit' | 'historical_only' | 'current_only';
  senderDistinctChatCount?: number;
}) {
  const senderDistinctChatCount = params.senderDistinctChatCount ?? 1;
  return {
    text: params.text,
    category: params.category,
    settings: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 45,
      commercialAdsDeleteThreshold: 65,
    },
    commercialCampaignContext: {
      senderDistinctChatCount,
      sameTextDistinctChatCount: senderDistinctChatCount,
      repeatedPhoneDistinctChatCount: 0,
      repeatedLinkDistinctChatCount: 0,
    },
  };
}

function contextFingerprint(senderDistinctChatCount: number): string {
  return fingerprintCommercialManualOverlayContext(
    {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 45,
      commercialAdsDeleteThreshold: 65,
    },
    {
      senderDistinctChatCount,
      sameTextDistinctChatCount: senderDistinctChatCount,
      repeatedPhoneDistinctChatCount: 0,
      repeatedLinkDistinctChatCount: 0,
    },
  );
}

describe('commercial manual overlay builder', () => {
  it('deduplicates annotations and emits one exact overlay row per matching corpus line', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const shortAnnotationsPath = join(directory, 'short.tsv');
    const duplicateAnnotationsPath = join(directory, 'duplicate.tsv');
    const actionAnnotationsPath = join(directory, 'action.tsv');
    const outputPath = join(directory, 'overlay.jsonl');
    const repeatedText = 'Ремонт квартир, звоните [phone]';
    const actionText = 'Вакансия продавца, зарплата 50000';
    const repeatedHash = sha256(repeatedText).slice(0, 12);
    const actionHash = sha256(actionText).slice(0, 12);
    const corpusBody =
      [
        corpusRecord({ text: repeatedText, category: 'stable_clear' }),
        corpusRecord({ text: repeatedText, category: 'stable_hit' }),
        corpusRecord({ text: actionText, category: 'stable_clear' }),
        corpusRecord({
          text: repeatedText,
          category: 'stable_clear',
          senderDistinctChatCount: 2,
        }),
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n';

    await writeFile(inputPath, corpusBody, 'utf8');
    await writeFile(
      shortAnnotationsPath,
      `hash\tevents\tclass\tconfidence\ttriage_offset\n${repeatedHash}\t3\tservice_offer\thigh\t1-100\n`,
      'utf8',
    );
    await writeFile(
      duplicateAnnotationsPath,
      `residual_offset\thash\tevents\texact_sanitized_text_json\tmanual_label\tconfidence\n1\t${repeatedHash}\t3\t${JSON.stringify(repeatedText)}\tservice_offer\thigh\n`,
      'utf8',
    );
    await writeFile(
      actionAnnotationsPath,
      `offset\thash\tevents\texact_sanitized_text_json\tcurrent_matched_signals\tcurrent_negative_signals\tcurrent_action\tcurrent_subtype\tmanual_label\tconfidence\trecommended_action\tmanual_evidence\tmanual_negative_considerations\n2\t${actionHash}\t1\t${JSON.stringify(actionText)}\t[]\t[]\tNONE\tnull\trecruitment\thigh\tWARN\trole|salary\tnone\n`,
      'utf8',
    );

    try {
      const summary = await buildCommercialManualOverlay({
        inputPath,
        annotationPaths: [shortAnnotationsPath, duplicateAnnotationsPath, actionAnnotationsPath],
        outputPath,
      });
      const records = (await readFile(outputPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as CommercialManualOverlayRecord);

      expect(summary).toEqual(
        expect.objectContaining({
          input: expect.objectContaining({ sha256: sha256(corpusBody), records: 4 }),
          annotations: expect.objectContaining({ rows: 3, uniqueHashes: 2 }),
          output: expect.objectContaining({ records: 4 }),
        }),
      );
      expect(records.map((record) => record.line)).toEqual([1, 2, 3, 4]);
      expect(records.every((record) => record.inputSha256 === sha256(corpusBody))).toBe(true);
      expect(records[0]).toEqual(
        expect.objectContaining({
          textSha256: sha256(repeatedText),
          manualLabel: 'service_offer',
          confidence: 'high',
          recommendedAction: null,
          sourceFiles: ['duplicate.tsv', 'short.tsv'],
          settings: expect.objectContaining({ commercialAdsWarnThreshold: 45 }),
          commercialCampaignContext: expect.objectContaining({ senderDistinctChatCount: 1 }),
          contextFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      );
      expect(records[1]).toEqual(
        expect.objectContaining({
          line: 2,
          textSha256: sha256(repeatedText),
          recommendedAction: null,
        }),
      );
      expect(records[3].contextFingerprint).not.toBe(records[0].contextFingerprint);
      expect(records[2]).toEqual(
        expect.objectContaining({
          manualLabel: 'recruitment',
          recommendedAction: 'WARN',
          sourceFiles: ['action.tsv'],
        }),
      );
      expect(
        records.flatMap((record) => record.sourceFiles).some((path) => path.includes('/')),
      ).toBe(false);
      expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
      await expect(
        buildCommercialManualOverlay({
          inputPath,
          annotationPaths: [shortAnnotationsPath],
          outputPath,
        }),
      ).rejects.toThrow('Output already exists');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts recommended actions for every corpus category', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-categories-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const annotationsPath = join(directory, 'annotations.tsv');
    const outputPath = join(directory, 'overlay.jsonl');
    const categories = ['stable_clear', 'stable_hit', 'historical_only', 'current_only'] as const;
    const texts = categories.map((category) => `Ручная проверка категории ${category}`);
    await writeFile(
      inputPath,
      `${categories
        .map((category, index) => JSON.stringify(corpusRecord({ text: texts[index], category })))
        .join('\n')}\n`,
      'utf8',
    );
    await writeFile(
      annotationsPath,
      `hash\tevents\tclass\tconfidence\trecommended_action\n${texts
        .map((text) => `${sha256(text).slice(0, 12)}\t1\tcommercial\thigh\tALLOW`)
        .join('\n')}\n`,
      'utf8',
    );

    try {
      const summary = await buildCommercialManualOverlay({
        inputPath,
        annotationPaths: [annotationsPath],
        outputPath,
      });
      const records = (await readFile(outputPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as CommercialManualOverlayRecord);

      expect(summary.output.records).toBe(4);
      expect(records.map((record) => record.line)).toEqual([1, 2, 3, 4]);
      expect(records.every((record) => record.recommendedAction === 'ALLOW')).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('binds different recommendations for the same text to exact corpus contexts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-contexts-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const baseAnnotationsPath = join(directory, 'base.tsv');
    const actionAnnotationsPath = join(directory, 'actions.tsv');
    const outputPath = join(directory, 'overlay.jsonl');
    const text = 'Одинаковый текст с разной историей распространения';
    const hash = sha256(text).slice(0, 12);
    await writeFile(
      inputPath,
      `${[
        corpusRecord({ text, category: 'stable_clear', senderDistinctChatCount: 1 }),
        corpusRecord({ text, category: 'current_only', senderDistinctChatCount: 3 }),
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`,
      'utf8',
    );
    await writeFile(
      baseAnnotationsPath,
      `hash\tevents\tmanual_label\tconfidence\n${hash}\t2\tcommercial\thigh\n`,
      'utf8',
    );
    await writeFile(
      actionAnnotationsPath,
      `hash\tevents\texact_sanitized_text_json\tmanual_label\tconfidence\trecommended_action\tcorpus_line\tcontext_fingerprint\n${hash}\t2\t${JSON.stringify(text)}\tcommercial\thigh\tALLOW\t1\t${contextFingerprint(1)}\n${hash}\t2\t${JSON.stringify(text)}\tcommercial\thigh\tWARN\t2\t${contextFingerprint(3)}\n`,
      'utf8',
    );

    try {
      const summary = await buildCommercialManualOverlay({
        inputPath,
        annotationPaths: [baseAnnotationsPath, actionAnnotationsPath],
        outputPath,
      });
      const records = (await readFile(outputPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as CommercialManualOverlayRecord);

      expect(summary).toEqual(
        expect.objectContaining({
          annotations: expect.objectContaining({ rows: 3, uniqueHashes: 1 }),
          output: expect.objectContaining({ records: 2 }),
        }),
      );
      expect(records.map(({ line, recommendedAction }) => ({ line, recommendedAction }))).toEqual([
        { line: 1, recommendedAction: 'ALLOW' },
        { line: 2, recommendedAction: 'WARN' },
      ]);
      expect(records[0].contextFingerprint).toBe(contextFingerprint(1));
      expect(records[1].contextFingerprint).toBe(contextFingerprint(3));
      expect(
        records.every((record) => record.sourceFiles.join(',') === 'actions.tsv,base.tsv'),
      ).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an unscoped recommendation for text with multiple corpus instances', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-ambiguous-action-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const annotationsPath = join(directory, 'annotations.tsv');
    const outputPath = join(directory, 'overlay.jsonl');
    const text = 'Одинаковое объявление в двух разных контекстах';
    const hash = sha256(text).slice(0, 12);
    await writeFile(
      inputPath,
      `${[
        corpusRecord({ text, category: 'stable_hit', senderDistinctChatCount: 1 }),
        corpusRecord({ text, category: 'current_only', senderDistinctChatCount: 4 }),
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`,
      'utf8',
    );
    await writeFile(
      annotationsPath,
      `hash\tevents\tclass\tconfidence\trecommended_action\n${hash}\t2\tcommercial\thigh\tDELETE\n`,
      'utf8',
    );

    try {
      await expect(
        buildCommercialManualOverlay({
          inputPath,
          annotationPaths: [annotationsPath],
          outputPath,
        }),
      ).rejects.toThrow('Ambiguous recommendedAction');
      await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a corpus line paired with a different context fingerprint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-selector-mismatch-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const annotationsPath = join(directory, 'annotations.tsv');
    const outputPath = join(directory, 'overlay.jsonl');
    const text = 'Проверка привязки рекомендации к контексту';
    const hash = sha256(text).slice(0, 12);
    await writeFile(
      inputPath,
      `${JSON.stringify(
        corpusRecord({ text, category: 'stable_hit', senderDistinctChatCount: 1 }),
      )}\n`,
      'utf8',
    );
    await writeFile(
      annotationsPath,
      `hash\tevents\tclass\tconfidence\trecommended_action\tcorpus_line\tcontext_fingerprint\n${hash}\t1\tcommercial\thigh\tWARN\t1\t${contextFingerprint(2)}\n`,
      'utf8',
    );

    try {
      await expect(
        buildCommercialManualOverlay({
          inputPath,
          annotationPaths: [annotationsPath],
          outputPath,
        }),
      ).rejects.toThrow('selector does not match any corpus line');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed on conflicting duplicate annotations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-conflict-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const firstPath = join(directory, 'first.tsv');
    const secondPath = join(directory, 'second.tsv');
    const outputPath = join(directory, 'overlay.jsonl');
    const text = 'Коммерческое предложение';
    const hash = sha256(text).slice(0, 12);
    await writeFile(
      inputPath,
      `${JSON.stringify(corpusRecord({ text, category: 'stable_clear' }))}\n`,
      'utf8',
    );
    await writeFile(firstPath, `hash\tevents\tclass\tconfidence\n${hash}\t1\tservice\thigh\n`);
    await writeFile(secondPath, `hash\tevents\tclass\tconfidence\n${hash}\t1\tretail\thigh\n`);

    try {
      await expect(
        buildCommercialManualOverlay({
          inputPath,
          annotationPaths: [firstPath, secondPath],
          outputPath,
        }),
      ).rejects.toThrow('Conflicting manualLabel');
      await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['unknown hash', 'Unknown manual annotation hash', 'unknown', 1],
    ['corpus count mismatch', 'declares 2 events but matches 1', 'known', 2],
  ])('fails closed on %s', async (_label, expectedError, hashKind, declaredEvents) => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-invalid-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const annotationsPath = join(directory, 'annotations.tsv');
    const outputPath = join(directory, 'overlay.jsonl');
    const text = 'Объявление с точным текстом';
    const corpusBody = `${JSON.stringify(corpusRecord({ text, category: 'stable_clear' }))}\n`;
    const hash = sha256(hashKind === 'known' ? text : 'missing text').slice(0, 12);
    await writeFile(inputPath, corpusBody, 'utf8');
    await writeFile(
      annotationsPath,
      `hash\tevents\tclass\tconfidence\n${hash}\t${declaredEvents}\tservice\thigh\n`,
      'utf8',
    );

    try {
      await expect(
        buildCommercialManualOverlay({ inputPath, annotationPaths: [annotationsPath], outputPath }),
      ).rejects.toThrow(expectedError);
      await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects exact annotation text whose SHA-256 does not match its hash', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-hash-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const annotationsPath = join(directory, 'annotations.tsv');
    const outputPath = join(directory, 'overlay.jsonl');
    const text = 'Исходный текст';
    const hash = sha256(text).slice(0, 12);
    await writeFile(
      inputPath,
      `${JSON.stringify(corpusRecord({ text, category: 'stable_clear' }))}\n`,
      'utf8',
    );
    await writeFile(
      annotationsPath,
      `offset\thash\tevents\texact_sanitized_text_json\tmanual_label\tconfidence\n1\t${hash}\t1\t${JSON.stringify('Другой текст')}\tservice\thigh\n`,
      'utf8',
    );

    try {
      await expect(
        buildCommercialManualOverlay({ inputPath, annotationPaths: [annotationsPath], outputPath }),
      ).rejects.toThrow('does not match hash');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects annotation paths whose logical basenames collide', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-source-name-'));
    try {
      await expect(
        buildCommercialManualOverlay({
          inputPath: join(directory, 'corpus.jsonl'),
          annotationPaths: [
            join(directory, 'first', 'review.tsv'),
            join(directory, 'second', 'review.tsv'),
          ],
          outputPath: join(directory, 'overlay.jsonl'),
        }),
      ).rejects.toThrow('Annotation file basenames must be unique');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects symlink and hard-link aliases before overwrite publication', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-path-alias-'));
    const realDirectory = join(directory, 'real');
    const aliasDirectory = join(directory, 'alias');
    const inputPath = join(realDirectory, 'corpus.jsonl');
    const annotationsPath = join(directory, 'annotations.tsv');
    const hardLinkedOutputPath = join(directory, 'annotation-output.tsv');
    const hardLinkedAnnotationsPath = join(directory, 'annotations-hardlink.tsv');
    const text = 'Проверка физической идентичности путей';
    const corpusBody = `${JSON.stringify(corpusRecord({ text, category: 'stable_clear' }))}\n`;
    const annotationsBody = `hash\tevents\tclass\tconfidence\n${sha256(text).slice(0, 12)}\t1\tservice\thigh\n`;

    try {
      await mkdir(realDirectory);
      await symlink(realDirectory, aliasDirectory, 'dir');
      await writeFile(inputPath, corpusBody, 'utf8');
      await writeFile(annotationsPath, annotationsBody, 'utf8');

      await expect(
        buildCommercialManualOverlay({
          inputPath,
          annotationPaths: [annotationsPath],
          outputPath: join(aliasDirectory, 'corpus.jsonl'),
          overwrite: true,
        }),
      ).rejects.toThrow('must resolve to different files');
      expect(await readFile(inputPath, 'utf8')).toBe(corpusBody);

      await link(annotationsPath, hardLinkedOutputPath);
      await expect(
        buildCommercialManualOverlay({
          inputPath,
          annotationPaths: [annotationsPath],
          outputPath: hardLinkedOutputPath,
          overwrite: true,
        }),
      ).rejects.toThrow('must resolve to different files');
      expect(await readFile(annotationsPath, 'utf8')).toBe(annotationsBody);

      await link(annotationsPath, hardLinkedAnnotationsPath);
      await expect(
        buildCommercialManualOverlay({
          inputPath,
          annotationPaths: [annotationsPath, hardLinkedAnnotationsPath],
          outputPath: join(directory, 'overlay.jsonl'),
          overwrite: true,
        }),
      ).rejects.toThrow('must resolve to different files');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses the cooperative output lock while publishing an overlay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-output-lock-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const annotationsPath = join(directory, 'annotations.tsv');
    const outputPath = join(directory, 'overlay.jsonl');
    const text = 'Проверка блокировки публикации';
    let releaseLock!: () => void;
    const holdLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let lockAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });

    await writeFile(
      inputPath,
      `${JSON.stringify(corpusRecord({ text, category: 'stable_clear' }))}\n`,
      'utf8',
    );
    await writeFile(
      annotationsPath,
      `hash\tevents\tclass\tconfidence\n${sha256(text).slice(0, 12)}\t1\tservice\thigh\n`,
      'utf8',
    );

    const competingPublisher = withCommercialOutputLocks([outputPath], async () => {
      lockAcquired();
      await holdLock;
    });
    try {
      await acquired;
      await expect(
        buildCommercialManualOverlay({ inputPath, annotationPaths: [annotationsPath], outputPath }),
      ).rejects.toThrow('Output is locked by another process');
      await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      releaseLock();
      await competingPublisher;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('parses repeated annotation options and keeps overwrite opt-in', () => {
    expect(
      readCommercialManualOverlayCliOptions([
        '--input',
        'corpus.jsonl',
        '--annotations',
        'one.tsv',
        '--annotations',
        'two.tsv',
        '--output',
        'overlay.jsonl',
      ]),
    ).toEqual({
      inputPath: 'corpus.jsonl',
      annotationPaths: ['one.tsv', 'two.tsv'],
      outputPath: 'overlay.jsonl',
      overwrite: false,
    });
    expect(() =>
      readCommercialManualOverlayCliOptions([
        '--input',
        'corpus.jsonl',
        '--output',
        'overlay.jsonl',
      ]),
    ).toThrow('Usage:');
  });
});
