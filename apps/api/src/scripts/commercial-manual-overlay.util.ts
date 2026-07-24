import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import {
  assertCommercialPathsDistinct,
  withCommercialOutputLocks,
} from './commercial-output-lock.util';

export const COMMERCIAL_MANUAL_OVERLAY_SCHEMA_VERSION = 'commercial-manual-overlay/v1';

const HASH_PREFIX_LENGTH = 12;
const HASH_PREFIX_PATTERN = /^[a-f0-9]{12}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RECOMMENDED_ACTIONS = new Set([
  'ALLOW',
  'REVIEW_ONLY',
  'WARN',
  'DELETE',
  'DELETE_AND_ESCALATE',
]);
const CAMPAIGN_CONTEXT_REQUIRED_FIELDS = [
  'senderDistinctChatCount',
  'sameTextDistinctChatCount',
  'repeatedPhoneDistinctChatCount',
  'repeatedLinkDistinctChatCount',
] as const;
const CAMPAIGN_CONTEXT_OPTIONAL_FIELDS = [
  'nearTextDistinctChatCount',
  'repeatedDomainDistinctChatCount',
  'repeatedHandleDistinctChatCount',
  'senderDistinctChatCount5m',
  'senderDistinctChatCount30m',
  'senderDistinctChatCount120m',
] as const;

export type CommercialManualRecommendedAction =
  | 'ALLOW'
  | 'REVIEW_ONLY'
  | 'WARN'
  | 'DELETE'
  | 'DELETE_AND_ESCALATE';

export type CommercialManualOverlaySettings = {
  commercialAdsSensitivity: 'BALANCED' | 'STRICT';
  commercialAdsWarnThreshold: number;
  commercialAdsDeleteThreshold: number;
};

export type CommercialManualOverlayCampaignContext = {
  senderDistinctChatCount: number;
  sameTextDistinctChatCount: number;
  repeatedPhoneDistinctChatCount: number;
  repeatedLinkDistinctChatCount: number;
  nearTextDistinctChatCount?: number;
  repeatedDomainDistinctChatCount?: number;
  repeatedHandleDistinctChatCount?: number;
  senderDistinctChatCount5m?: number;
  senderDistinctChatCount30m?: number;
  senderDistinctChatCount120m?: number;
};

export type CommercialManualOverlayRecord = {
  schemaVersion: typeof COMMERCIAL_MANUAL_OVERLAY_SCHEMA_VERSION;
  inputSha256: string;
  line: number;
  textSha256: string;
  manualLabel: string;
  confidence: string;
  recommendedAction: CommercialManualRecommendedAction | null;
  sourceFiles: string[];
  settings: CommercialManualOverlaySettings;
  commercialCampaignContext: CommercialManualOverlayCampaignContext | null;
  contextFingerprint: string;
};

export type BuildCommercialManualOverlayOptions = {
  inputPath: string;
  annotationPaths: readonly string[];
  outputPath: string;
  overwrite?: boolean;
};

export type BuildCommercialManualOverlaySummary = {
  schemaVersion: typeof COMMERCIAL_MANUAL_OVERLAY_SCHEMA_VERSION;
  input: {
    path: string;
    sha256: string;
    records: number;
  };
  annotations: {
    paths: string[];
    rows: number;
    uniqueHashes: number;
  };
  output: {
    path: string;
    records: number;
  };
};

type ParsedAnnotation = {
  hashPrefix: string;
  declaredEvents: number;
  manualLabel: string;
  confidence: string;
  recommendedAction: CommercialManualRecommendedAction | null;
  exactText: string | null;
  corpusLine: number | null;
  contextFingerprint: string | null;
  sourceFiles: Set<string>;
  seenTextHashes: Set<string>;
  corpusMatches: MatchedCorpusRecord[];
};

type MatchedCorpusRecord = {
  line: number;
  textSha256: string;
  settings: CommercialManualOverlaySettings;
  commercialCampaignContext: CommercialManualOverlayCampaignContext | null;
  contextFingerprint: string;
};

type ParsedAnnotationFile = {
  path: string;
  rows: ParsedAnnotation[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function readNonEmptyCell(
  cells: readonly string[],
  headers: ReadonlyMap<string, number>,
  field: string,
  sourcePath: string,
  line: number,
): string {
  const index = headers.get(field);
  const value = index === undefined ? '' : (cells[index] ?? '').trim();
  if (!value) {
    throw new Error(`Invalid annotation ${sourcePath}:${line}: ${field} is required`);
  }
  return value;
}

function readOptionalCell(
  cells: readonly string[],
  headers: ReadonlyMap<string, number>,
  field: string,
): string | null {
  const index = headers.get(field);
  if (index === undefined) {
    return null;
  }
  const value = (cells[index] ?? '').trim();
  return value || null;
}

function parsePositiveInteger(value: string, field: string, sourcePath: string, line: number) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid annotation ${sourcePath}:${line}: ${field} must be a positive integer`,
    );
  }
  return parsed;
}

function parseRecommendedAction(
  value: string | null,
  sourcePath: string,
  line: number,
): CommercialManualRecommendedAction | null {
  if (value === null) {
    return null;
  }
  if (!RECOMMENDED_ACTIONS.has(value)) {
    throw new Error(
      `Invalid annotation ${sourcePath}:${line}: unsupported recommended_action ${value}`,
    );
  }
  return value as CommercialManualRecommendedAction;
}

function physicalLines(value: string): string[] {
  const lines = value.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

async function parseAnnotationFile(annotationPath: string): Promise<ParsedAnnotationFile> {
  const sourcePath = resolve(annotationPath);
  const sourceName = basename(sourcePath);
  const lines = physicalLines(await readFile(sourcePath, 'utf8'));
  if (lines.length < 2) {
    throw new Error(`Invalid annotation ${sourcePath}: expected a header and at least one row`);
  }

  const headerCells = lines[0].split('\t');
  const headers = new Map<string, number>();
  for (const [index, rawHeader] of headerCells.entries()) {
    const header = rawHeader.replace(/^\uFEFF/u, '').trim();
    if (!header || headers.has(header)) {
      throw new Error(`Invalid annotation ${sourcePath}: duplicate or empty header ${header}`);
    }
    headers.set(header, index);
  }
  for (const required of ['hash', 'events', 'confidence']) {
    if (!headers.has(required)) {
      throw new Error(`Invalid annotation ${sourcePath}: missing ${required} header`);
    }
  }
  if (!headers.has('manual_label') && !headers.has('class')) {
    throw new Error(`Invalid annotation ${sourcePath}: missing manual_label/class header`);
  }

  const rows: ParsedAnnotation[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const physicalLine = index + 1;
    const line = lines[index];
    if (!line) {
      throw new Error(`Invalid annotation ${sourcePath}:${physicalLine}: empty row`);
    }
    const cells = line.split('\t');
    if (cells.length !== headerCells.length) {
      throw new Error(
        `Invalid annotation ${sourcePath}:${physicalLine}: expected ${headerCells.length} columns, found ${cells.length}`,
      );
    }

    const hashPrefix = readNonEmptyCell(
      cells,
      headers,
      'hash',
      sourcePath,
      physicalLine,
    ).toLowerCase();
    if (!HASH_PREFIX_PATTERN.test(hashPrefix)) {
      throw new Error(
        `Invalid annotation ${sourcePath}:${physicalLine}: hash must be 12 lowercase hex characters`,
      );
    }
    const classLabel = readOptionalCell(cells, headers, 'class');
    const manualLabel = readOptionalCell(cells, headers, 'manual_label');
    if (classLabel && manualLabel && classLabel !== manualLabel) {
      throw new Error(
        `Invalid annotation ${sourcePath}:${physicalLine}: class and manual_label conflict`,
      );
    }
    const resolvedLabel = manualLabel ?? classLabel;
    if (!resolvedLabel) {
      throw new Error(
        `Invalid annotation ${sourcePath}:${physicalLine}: manual_label/class is required`,
      );
    }

    const exactTextJson = readOptionalCell(cells, headers, 'exact_sanitized_text_json');
    let exactText: string | null = null;
    if (exactTextJson !== null) {
      try {
        const parsed = JSON.parse(exactTextJson) as unknown;
        if (typeof parsed !== 'string' || !parsed) {
          throw new Error('value is not a non-empty JSON string');
        }
        exactText = parsed;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Invalid annotation ${sourcePath}:${physicalLine}: exact_sanitized_text_json ${message}`,
        );
      }
      const exactHash = sha256(exactText);
      if (!exactHash.startsWith(hashPrefix)) {
        throw new Error(
          `Invalid annotation ${sourcePath}:${physicalLine}: exact text SHA-256 ${exactHash} does not match hash ${hashPrefix}`,
        );
      }
    }

    const corpusLineCell = readOptionalCell(cells, headers, 'corpus_line');
    const corpusLine =
      corpusLineCell === null
        ? null
        : parsePositiveInteger(corpusLineCell, 'corpus_line', sourcePath, physicalLine);
    const contextFingerprint = readOptionalCell(cells, headers, 'context_fingerprint');
    if (contextFingerprint !== null && !SHA256_PATTERN.test(contextFingerprint)) {
      throw new Error(
        `Invalid annotation ${sourcePath}:${physicalLine}: context_fingerprint must be 64 lowercase hex characters`,
      );
    }

    rows.push({
      hashPrefix,
      declaredEvents: parsePositiveInteger(
        readNonEmptyCell(cells, headers, 'events', sourcePath, physicalLine),
        'events',
        sourcePath,
        physicalLine,
      ),
      manualLabel: resolvedLabel,
      confidence: readNonEmptyCell(cells, headers, 'confidence', sourcePath, physicalLine),
      recommendedAction: parseRecommendedAction(
        readOptionalCell(cells, headers, 'recommended_action'),
        sourcePath,
        physicalLine,
      ),
      exactText,
      corpusLine,
      contextFingerprint,
      sourceFiles: new Set([sourceName]),
      seenTextHashes: new Set(),
      corpusMatches: [],
    });
  }
  return { path: sourcePath, rows };
}

function mergeAnnotation(target: ParsedAnnotation, incoming: ParsedAnnotation): void {
  const source = [...incoming.sourceFiles][0] ?? 'unknown annotation';
  if (target.declaredEvents !== incoming.declaredEvents) {
    throw new Error(
      `Conflicting events for manual annotation ${target.hashPrefix}: ${target.declaredEvents} vs ${incoming.declaredEvents} in ${source}`,
    );
  }
  if (target.manualLabel !== incoming.manualLabel) {
    throw new Error(
      `Conflicting manualLabel for manual annotation ${target.hashPrefix}: ${target.manualLabel} vs ${incoming.manualLabel} in ${source}`,
    );
  }
  if (target.confidence !== incoming.confidence) {
    throw new Error(
      `Conflicting confidence for manual annotation ${target.hashPrefix}: ${target.confidence} vs ${incoming.confidence} in ${source}`,
    );
  }
  if (
    target.recommendedAction &&
    incoming.recommendedAction &&
    target.recommendedAction !== incoming.recommendedAction
  ) {
    throw new Error(
      `Conflicting recommendedAction for manual annotation ${target.hashPrefix}: ${target.recommendedAction} vs ${incoming.recommendedAction} in ${source}`,
    );
  }
  if (target.exactText && incoming.exactText && target.exactText !== incoming.exactText) {
    throw new Error(
      `Conflicting exact text for manual annotation ${target.hashPrefix} in ${source}`,
    );
  }
  if (
    target.corpusLine !== incoming.corpusLine ||
    target.contextFingerprint !== incoming.contextFingerprint
  ) {
    throw new Error(`Cannot merge manual annotations with different selectors`);
  }
  target.recommendedAction ??= incoming.recommendedAction;
  target.exactText ??= incoming.exactText;
  for (const sourceFile of incoming.sourceFiles) {
    target.sourceFiles.add(sourceFile);
  }
}

function annotationSelectorKey(annotation: ParsedAnnotation): string {
  return [
    annotation.hashPrefix,
    annotation.corpusLine === null ? '*' : String(annotation.corpusLine),
    annotation.contextFingerprint ?? '*',
  ].join(':');
}

function selectedCorpusMatches(annotation: ParsedAnnotation): MatchedCorpusRecord[] {
  return annotation.corpusMatches.filter(
    (match) =>
      (annotation.corpusLine === null || match.line === annotation.corpusLine) &&
      (annotation.contextFingerprint === null ||
        match.contextFingerprint === annotation.contextFingerprint),
  );
}

function readFiniteNumber(record: Record<string, unknown>, field: string, corpusLine: number) {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid corpus record at line ${corpusLine}: ${field} must be finite`);
  }
  return value;
}

function parseSettings(value: unknown, corpusLine: number): CommercialManualOverlaySettings {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`Invalid corpus record at line ${corpusLine}: settings are missing`);
  }
  const sensitivity = record.commercialAdsSensitivity;
  if (sensitivity !== 'BALANCED' && sensitivity !== 'STRICT') {
    throw new Error(
      `Invalid corpus record at line ${corpusLine}: unsupported commercialAdsSensitivity`,
    );
  }
  const settings: CommercialManualOverlaySettings = {
    commercialAdsSensitivity: sensitivity,
    commercialAdsWarnThreshold: readFiniteNumber(record, 'commercialAdsWarnThreshold', corpusLine),
    commercialAdsDeleteThreshold: readFiniteNumber(
      record,
      'commercialAdsDeleteThreshold',
      corpusLine,
    ),
  };
  if (
    !Number.isSafeInteger(settings.commercialAdsWarnThreshold) ||
    settings.commercialAdsWarnThreshold < 10 ||
    settings.commercialAdsWarnThreshold > 90
  ) {
    throw new Error(
      `Invalid corpus record at line ${corpusLine}: commercialAdsWarnThreshold must be an integer in [10, 90]`,
    );
  }
  if (
    !Number.isSafeInteger(settings.commercialAdsDeleteThreshold) ||
    settings.commercialAdsDeleteThreshold < 20 ||
    settings.commercialAdsDeleteThreshold > 100
  ) {
    throw new Error(
      `Invalid corpus record at line ${corpusLine}: commercialAdsDeleteThreshold must be an integer in [20, 100]`,
    );
  }
  if (settings.commercialAdsDeleteThreshold <= settings.commercialAdsWarnThreshold) {
    throw new Error(
      `Invalid corpus record at line ${corpusLine}: commercialAdsDeleteThreshold must be greater than commercialAdsWarnThreshold`,
    );
  }
  return settings;
}

function parseCampaignContext(
  value: unknown,
  corpusLine: number,
): CommercialManualOverlayCampaignContext | null {
  if (value === null) {
    return null;
  }
  const record = asRecord(value);
  if (!record) {
    throw new Error(
      `Invalid corpus record at line ${corpusLine}: commercialCampaignContext must be an object or null`,
    );
  }
  const context: Record<string, number> = {};
  for (const field of CAMPAIGN_CONTEXT_REQUIRED_FIELDS) {
    const number = readFiniteNumber(record, field, corpusLine);
    if (!Number.isSafeInteger(number) || number < 0) {
      throw new Error(
        `Invalid corpus record at line ${corpusLine}: commercialCampaignContext.${field} must be a non-negative integer`,
      );
    }
    context[field] = number;
  }
  for (const field of CAMPAIGN_CONTEXT_OPTIONAL_FIELDS) {
    if (record[field] === undefined) {
      continue;
    }
    const number = readFiniteNumber(record, field, corpusLine);
    if (!Number.isSafeInteger(number) || number < 0) {
      throw new Error(
        `Invalid corpus record at line ${corpusLine}: commercialCampaignContext.${field} must be a non-negative integer`,
      );
    }
    context[field] = number;
  }
  return context as CommercialManualOverlayCampaignContext;
}

export function fingerprintCommercialManualOverlayContext(
  settings: CommercialManualOverlaySettings,
  commercialCampaignContext: CommercialManualOverlayCampaignContext | null,
): string {
  return sha256(JSON.stringify({ settings, commercialCampaignContext }));
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonlAtomically(
  pathname: string,
  records: readonly unknown[],
  overwrite: boolean,
) {
  await mkdir(dirname(pathname), { recursive: true });
  if (!overwrite && (await pathExists(pathname))) {
    throw new Error(`Output already exists: ${pathname}. Pass --overwrite to replace it.`);
  }
  const temporaryPath = `${pathname}.${process.pid}.${Date.now()}.tmp`;
  const body = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  try {
    await writeFile(temporaryPath, body, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    if (overwrite) {
      await rename(temporaryPath, pathname);
    } else {
      await link(temporaryPath, pathname);
      await unlink(temporaryPath);
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    const code = asRecord(error)?.code;
    if (!overwrite && code === 'EEXIST') {
      throw new Error(`Output already exists: ${pathname}. Pass --overwrite to replace it.`);
    }
    throw error;
  }
}

export async function buildCommercialManualOverlay(
  options: BuildCommercialManualOverlayOptions,
): Promise<BuildCommercialManualOverlaySummary> {
  const inputPath = resolve(options.inputPath);
  const outputPath = resolve(options.outputPath);
  const annotationPaths = options.annotationPaths.map((path) => resolve(path));
  const overwrite = options.overwrite === true;
  if (annotationPaths.length === 0) {
    throw new Error('At least one annotation path is required');
  }
  if (new Set(annotationPaths).size !== annotationPaths.length) {
    throw new Error('Annotation paths must be unique');
  }
  const annotationSourceNames = annotationPaths.map((path) => basename(path));
  if (new Set(annotationSourceNames).size !== annotationSourceNames.length) {
    throw new Error('Annotation file basenames must be unique');
  }
  if (outputPath === inputPath || annotationPaths.includes(outputPath)) {
    throw new Error('Output path must differ from the input and annotation paths');
  }
  await assertCommercialPathsDistinct([inputPath, ...annotationPaths, outputPath]);
  if (!overwrite && (await pathExists(outputPath))) {
    throw new Error(`Output already exists: ${outputPath}. Pass --overwrite to replace it.`);
  }

  const annotationFiles = await Promise.all(annotationPaths.map(parseAnnotationFile));
  const annotations = new Map<string, ParsedAnnotation>();
  let annotationRows = 0;
  for (const file of annotationFiles) {
    for (const annotation of file.rows) {
      annotationRows += 1;
      const selectorKey = annotationSelectorKey(annotation);
      const existing = annotations.get(selectorKey);
      if (existing) {
        mergeAnnotation(existing, annotation);
      } else {
        annotations.set(selectorKey, annotation);
      }
    }
  }
  const annotationsByHash = new Map<string, ParsedAnnotation[]>();
  for (const annotation of annotations.values()) {
    const grouped = annotationsByHash.get(annotation.hashPrefix) ?? [];
    grouped.push(annotation);
    annotationsByHash.set(annotation.hashPrefix, grouped);
  }

  const inputHash = createHash('sha256');
  const input = createReadStream(inputPath);
  input.on('data', (chunk) => inputHash.update(chunk));
  const reader = createInterface({ input, crlfDelay: Infinity });
  let physicalLine = 0;
  let corpusRecords = 0;
  try {
    for await (const line of reader) {
      physicalLine += 1;
      if (!line.trim()) {
        continue;
      }
      corpusRecords += 1;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid corpus JSON at line ${physicalLine}: ${message}`);
      }
      const record = asRecord(value);
      if (!record || typeof record.text !== 'string' || !record.text) {
        throw new Error(`Invalid corpus record at line ${physicalLine}: text is required`);
      }
      const textSha256 = sha256(record.text);
      const matchingAnnotations = annotationsByHash.get(textSha256.slice(0, HASH_PREFIX_LENGTH));
      if (!matchingAnnotations) {
        continue;
      }
      const settings = parseSettings(record.settings, physicalLine);
      const commercialCampaignContext = parseCampaignContext(
        record.commercialCampaignContext,
        physicalLine,
      );
      const match: MatchedCorpusRecord = {
        line: physicalLine,
        textSha256,
        settings,
        commercialCampaignContext,
        contextFingerprint: fingerprintCommercialManualOverlayContext(
          settings,
          commercialCampaignContext,
        ),
      };
      for (const annotation of matchingAnnotations) {
        annotation.seenTextHashes.add(textSha256);
        if (annotation.exactText !== null && annotation.exactText !== record.text) {
          throw new Error(
            `Corpus text at line ${physicalLine} conflicts with exact annotation ${annotation.hashPrefix}`,
          );
        }
        annotation.corpusMatches.push(match);
      }
    }
  } finally {
    reader.close();
  }
  const inputSha256 = inputHash.digest('hex');

  for (const annotation of annotations.values()) {
    if (annotation.seenTextHashes.size === 0) {
      throw new Error(`Unknown manual annotation hash ${annotation.hashPrefix}`);
    }
    if (annotation.seenTextHashes.size > 1) {
      throw new Error(
        `Ambiguous manual annotation hash ${annotation.hashPrefix}: matches multiple full text hashes`,
      );
    }
    if (annotation.corpusMatches.length !== annotation.declaredEvents) {
      throw new Error(
        `Manual annotation ${annotation.hashPrefix} declares ${annotation.declaredEvents} events but matches ${annotation.corpusMatches.length} corpus lines`,
      );
    }
    const selectedMatches = selectedCorpusMatches(annotation);
    if (
      (annotation.corpusLine !== null || annotation.contextFingerprint !== null) &&
      selectedMatches.length === 0
    ) {
      throw new Error(
        `Manual annotation ${annotation.hashPrefix} selector does not match any corpus line`,
      );
    }
    if (
      annotation.recommendedAction !== null &&
      annotation.corpusLine === null &&
      annotation.contextFingerprint === null &&
      selectedMatches.length > 1
    ) {
      throw new Error(
        `Ambiguous recommendedAction for manual annotation ${annotation.hashPrefix}: matches ${selectedMatches.length} corpus lines without corpus_line or context_fingerprint`,
      );
    }
  }

  const overlayRecordsByLine = new Map<number, CommercialManualOverlayRecord>();
  for (const annotation of annotations.values()) {
    for (const match of selectedCorpusMatches(annotation)) {
      const existing = overlayRecordsByLine.get(match.line);
      if (existing) {
        if (existing.manualLabel !== annotation.manualLabel) {
          throw new Error(
            `Conflicting manualLabel for corpus line ${match.line}: ${existing.manualLabel} vs ${annotation.manualLabel}`,
          );
        }
        if (existing.confidence !== annotation.confidence) {
          throw new Error(
            `Conflicting confidence for corpus line ${match.line}: ${existing.confidence} vs ${annotation.confidence}`,
          );
        }
        if (
          existing.recommendedAction !== null &&
          annotation.recommendedAction !== null &&
          existing.recommendedAction !== annotation.recommendedAction
        ) {
          throw new Error(
            `Conflicting recommendedAction for corpus line ${match.line}: ${existing.recommendedAction} vs ${annotation.recommendedAction}`,
          );
        }
        existing.recommendedAction ??= annotation.recommendedAction;
        existing.sourceFiles = [
          ...new Set([...existing.sourceFiles, ...annotation.sourceFiles]),
        ].sort();
        continue;
      }
      overlayRecordsByLine.set(match.line, {
        schemaVersion: COMMERCIAL_MANUAL_OVERLAY_SCHEMA_VERSION,
        inputSha256,
        line: match.line,
        textSha256: match.textSha256,
        manualLabel: annotation.manualLabel,
        confidence: annotation.confidence,
        recommendedAction: annotation.recommendedAction,
        sourceFiles: [...annotation.sourceFiles].sort(),
        settings: match.settings,
        commercialCampaignContext: match.commercialCampaignContext,
        contextFingerprint: match.contextFingerprint,
      });
    }
  }
  const overlayRecords = [...overlayRecordsByLine.values()].sort(
    (left, right) => left.line - right.line,
  );

  await withCommercialOutputLocks([outputPath], () =>
    writeJsonlAtomically(outputPath, overlayRecords, overwrite),
  );
  return {
    schemaVersion: COMMERCIAL_MANUAL_OVERLAY_SCHEMA_VERSION,
    input: {
      path: inputPath,
      sha256: inputSha256,
      records: corpusRecords,
    },
    annotations: {
      paths: annotationFiles.map((file) => file.path),
      rows: annotationRows,
      uniqueHashes: annotationsByHash.size,
    },
    output: {
      path: outputPath,
      records: overlayRecords.length,
    },
  };
}
