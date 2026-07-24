import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';

import {
  COMMERCIAL_MANUAL_OVERLAY_SCHEMA_VERSION,
  fingerprintCommercialManualOverlayContext,
  type CommercialManualOverlayCampaignContext,
  type CommercialManualOverlayRecord,
  type CommercialManualOverlaySettings,
  type CommercialManualRecommendedAction,
} from './commercial-manual-overlay.util';
import {
  assertCommercialOutputLockPathsSafe,
  withCommercialOutputLocks,
} from './commercial-output-lock.util';

export const COMMERCIAL_MANUAL_OVERLAY_REMAP_SCHEMA_VERSION =
  'commercial-manual-overlay-remap/v1';

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

export type RemapCommercialManualOverlayOptions = {
  sourceInputPath: string;
  targetInputPath: string;
  overlayPath: string;
  outputPath: string;
  summaryOutputPath: string;
};

export type CommercialManualOverlayRemapSummary = {
  schemaVersion: typeof COMMERCIAL_MANUAL_OVERLAY_REMAP_SCHEMA_VERSION;
  createdAt: string;
  source: {
    path: string;
    sha256: string;
    records: number;
  };
  target: {
    path: string;
    sha256: string;
    records: number;
  };
  overlay: {
    path: string;
    sha256: string;
    records: number;
  };
  validation: {
    sourceTextHashes: number;
    contextFingerprints: number;
    changedTextHashes: number;
  };
  output: {
    path: string;
    sha256: string;
    records: number;
    mode: '0600';
    publication: 'atomic-hard-link-no-clobber';
  };
};

type ParsedOverlay = {
  path: string;
  sha256: string;
  inputSha256: string;
  records: CommercialManualOverlayRecord[];
  recordsByLine: Map<number, CommercialManualOverlayRecord>;
};

type SelectedCorpusRecord = {
  textSha256: string;
  settings: CommercialManualOverlaySettings;
  commercialCampaignContext: CommercialManualOverlayCampaignContext | null;
  contextFingerprint: string;
};

type ScannedCorpus = {
  path: string;
  sha256: string;
  records: number;
  selectedByLine: Map<number, SelectedCorpusRecord>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorCode(error: unknown): string | null {
  return asRecord(error)?.code as string | null;
}

function readRequiredString(
  record: Record<string, unknown>,
  field: string,
  location: string,
): string {
  const value = record[field];
  if (typeof value !== 'string' || !value) {
    throw new Error(`Invalid ${location}: ${field} must be a non-empty string`);
  }
  return value;
}

function readNonNegativeInteger(
  record: Record<string, unknown>,
  field: string,
  location: string,
): number {
  const value = record[field];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid ${location}: ${field} must be a non-negative integer`);
  }
  return value as number;
}

function parseSettings(value: unknown, location: string): CommercialManualOverlaySettings {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`Invalid ${location}: settings are missing`);
  }
  const sensitivity = record.commercialAdsSensitivity;
  if (sensitivity !== 'BALANCED' && sensitivity !== 'STRICT') {
    throw new Error(`Invalid ${location}: unsupported commercialAdsSensitivity`);
  }
  const warnThreshold = readNonNegativeInteger(
    record,
    'commercialAdsWarnThreshold',
    location,
  );
  const deleteThreshold = readNonNegativeInteger(
    record,
    'commercialAdsDeleteThreshold',
    location,
  );
  if (
    warnThreshold < 10 ||
    warnThreshold > 90 ||
    deleteThreshold < 20 ||
    deleteThreshold > 100 ||
    deleteThreshold <= warnThreshold
  ) {
    throw new Error(`Invalid ${location}: unsupported commercial thresholds`);
  }
  return {
    commercialAdsSensitivity: sensitivity,
    commercialAdsWarnThreshold: warnThreshold,
    commercialAdsDeleteThreshold: deleteThreshold,
  };
}

function parseCampaignContext(
  value: unknown,
  location: string,
): CommercialManualOverlayCampaignContext | null {
  if (value === null) {
    return null;
  }
  const record = asRecord(value);
  if (!record) {
    throw new Error(
      `Invalid ${location}: commercialCampaignContext must be an object or null`,
    );
  }
  const context: Record<string, number> = {};
  for (const field of CAMPAIGN_CONTEXT_REQUIRED_FIELDS) {
    context[field] = readNonNegativeInteger(record, field, location);
  }
  for (const field of CAMPAIGN_CONTEXT_OPTIONAL_FIELDS) {
    if (record[field] !== undefined) {
      context[field] = readNonNegativeInteger(record, field, location);
    }
  }
  return context as CommercialManualOverlayCampaignContext;
}

function parseSourceFiles(value: unknown, location: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (item) =>
        typeof item !== 'string' ||
        !item ||
        item === '.' ||
        item === '..' ||
        item.includes('/') ||
        item.includes('\\'),
    )
  ) {
    throw new Error(`Invalid ${location}: sourceFiles must contain logical basenames`);
  }
  const sourceFiles = value as string[];
  if (new Set(sourceFiles).size !== sourceFiles.length) {
    throw new Error(`Invalid ${location}: sourceFiles must be unique`);
  }
  return [...sourceFiles];
}

function parseRecommendedAction(
  value: unknown,
  location: string,
): CommercialManualRecommendedAction | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !RECOMMENDED_ACTIONS.has(value)) {
    throw new Error(`Invalid ${location}: unsupported recommendedAction`);
  }
  return value as CommercialManualRecommendedAction;
}

async function parseOverlay(pathname: string): Promise<ParsedOverlay> {
  const path = resolve(pathname);
  const body = await readFile(path, 'utf8');
  const lines = body.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  if (lines.length === 0) {
    throw new Error(`Invalid overlay ${path}: expected at least one record`);
  }

  const records: CommercialManualOverlayRecord[] = [];
  const recordsByLine = new Map<number, CommercialManualOverlayRecord>();
  let inputSha256: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const location = `overlay ${path}:${index + 1}`;
    if (!lines[index]) {
      throw new Error(`Invalid ${location}: empty JSONL record`);
    }
    let value: unknown;
    try {
      value = JSON.parse(lines[index]) as unknown;
    } catch (error) {
      throw new Error(`Invalid ${location}: ${String(error)}`);
    }
    const record = asRecord(value);
    if (!record || record.schemaVersion !== COMMERCIAL_MANUAL_OVERLAY_SCHEMA_VERSION) {
      throw new Error(`Invalid ${location}: unsupported schemaVersion`);
    }
    const recordInputSha256 = readRequiredString(record, 'inputSha256', location);
    const textSha256 = readRequiredString(record, 'textSha256', location);
    const contextFingerprint = readRequiredString(record, 'contextFingerprint', location);
    if (
      !SHA256_PATTERN.test(recordInputSha256) ||
      !SHA256_PATTERN.test(textSha256) ||
      !SHA256_PATTERN.test(contextFingerprint)
    ) {
      throw new Error(`Invalid ${location}: SHA-256 fields must be lowercase hex`);
    }
    inputSha256 ??= recordInputSha256;
    if (inputSha256 !== recordInputSha256) {
      throw new Error(`Invalid ${location}: conflicting inputSha256`);
    }
    const corpusLine = record.line;
    if (!Number.isSafeInteger(corpusLine) || (corpusLine as number) <= 0) {
      throw new Error(`Invalid ${location}: line must be a positive integer`);
    }
    if (recordsByLine.has(corpusLine as number)) {
      throw new Error(`Invalid ${location}: duplicate corpus line ${corpusLine}`);
    }
    const settings = parseSettings(record.settings, location);
    const commercialCampaignContext = parseCampaignContext(
      record.commercialCampaignContext,
      location,
    );
    if (
      fingerprintCommercialManualOverlayContext(settings, commercialCampaignContext) !==
      contextFingerprint
    ) {
      throw new Error(`Invalid ${location}: contextFingerprint mismatch`);
    }
    const parsed: CommercialManualOverlayRecord = {
      schemaVersion: COMMERCIAL_MANUAL_OVERLAY_SCHEMA_VERSION,
      inputSha256: recordInputSha256,
      line: corpusLine as number,
      textSha256,
      manualLabel: readRequiredString(record, 'manualLabel', location),
      confidence: readRequiredString(record, 'confidence', location),
      recommendedAction: parseRecommendedAction(record.recommendedAction, location),
      sourceFiles: parseSourceFiles(record.sourceFiles, location),
      settings,
      commercialCampaignContext,
      contextFingerprint,
    };
    records.push(parsed);
    recordsByLine.set(parsed.line, parsed);
  }
  return {
    path,
    sha256: sha256(body),
    inputSha256: inputSha256 as string,
    records,
    recordsByLine,
  };
}

async function scanCorpus(
  pathname: string,
  selectedLines: ReadonlySet<number>,
): Promise<ScannedCorpus> {
  const path = resolve(pathname);
  const inputHash = createHash('sha256');
  const input = createReadStream(path);
  input.on('data', (chunk) => inputHash.update(chunk));
  const reader = createInterface({ input, crlfDelay: Infinity });
  const selectedByLine = new Map<number, SelectedCorpusRecord>();
  let physicalLine = 0;
  let records = 0;
  try {
    for await (const line of reader) {
      physicalLine += 1;
      if (!line.trim()) {
        if (selectedLines.has(physicalLine)) {
          throw new Error(`Invalid corpus ${path}:${physicalLine}: selected line is empty`);
        }
        continue;
      }
      records += 1;
      if (!selectedLines.has(physicalLine)) {
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch (error) {
        throw new Error(`Invalid corpus ${path}:${physicalLine}: ${String(error)}`);
      }
      const record = asRecord(value);
      if (!record || typeof record.text !== 'string' || !record.text) {
        throw new Error(`Invalid corpus ${path}:${physicalLine}: text is required`);
      }
      const location = `corpus ${path}:${physicalLine}`;
      const settings = parseSettings(record.settings, location);
      const commercialCampaignContext = parseCampaignContext(
        record.commercialCampaignContext,
        location,
      );
      selectedByLine.set(physicalLine, {
        textSha256: sha256(record.text),
        settings,
        commercialCampaignContext,
        contextFingerprint: fingerprintCommercialManualOverlayContext(
          settings,
          commercialCampaignContext,
        ),
      });
    }
  } finally {
    reader.close();
  }
  if (selectedByLine.size !== selectedLines.size) {
    const missing = [...selectedLines].find((line) => !selectedByLine.has(line));
    throw new Error(`Corpus ${path} is missing selected line ${missing}`);
  }
  return {
    path,
    sha256: inputHash.digest('hex'),
    records,
    selectedByLine,
  };
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function publishNoClobberPair(params: {
  outputPath: string;
  outputBody: string;
  summaryOutputPath: string;
  summaryBody: string;
}): Promise<void> {
  await mkdir(dirname(params.outputPath), { recursive: true });
  await mkdir(dirname(params.summaryOutputPath), { recursive: true });
  if (await pathExists(params.outputPath)) {
    throw new Error(`Output already exists: ${params.outputPath}`);
  }
  if (await pathExists(params.summaryOutputPath)) {
    throw new Error(`Output already exists: ${params.summaryOutputPath}`);
  }
  const token = `${process.pid}.${randomUUID()}`;
  const temporaryOutputPath = `${params.outputPath}.${token}.tmp`;
  const temporarySummaryPath = `${params.summaryOutputPath}.${token}.tmp`;
  let outputPublished = false;
  try {
    await writeFile(temporaryOutputPath, params.outputBody, { flag: 'wx', mode: 0o600 });
    await writeFile(temporarySummaryPath, params.summaryBody, { flag: 'wx', mode: 0o600 });
    await link(temporaryOutputPath, params.outputPath);
    outputPublished = true;
    await link(temporarySummaryPath, params.summaryOutputPath);
  } catch (error) {
    if (outputPublished) {
      await unlink(params.outputPath).catch(() => undefined);
    }
    if (errorCode(error) === 'EEXIST') {
      throw new Error('Commercial overlay remap output already exists', { cause: error });
    }
    throw error;
  } finally {
    await Promise.all([
      unlink(temporaryOutputPath).catch(() => undefined),
      unlink(temporarySummaryPath).catch(() => undefined),
    ]);
  }
}

export async function remapCommercialManualOverlay(
  options: RemapCommercialManualOverlayOptions,
): Promise<CommercialManualOverlayRemapSummary> {
  const sourceInputPath = resolve(options.sourceInputPath);
  const targetInputPath = resolve(options.targetInputPath);
  const overlayPath = resolve(options.overlayPath);
  const outputPath = resolve(options.outputPath);
  const summaryOutputPath = resolve(options.summaryOutputPath);
  const allPaths = [
    sourceInputPath,
    targetInputPath,
    overlayPath,
    outputPath,
    summaryOutputPath,
  ];
  if (new Set(allPaths).size !== allPaths.length) {
    throw new Error('Source, target, overlay, output, and summary paths must be distinct');
  }
  await assertCommercialOutputLockPathsSafe([outputPath, summaryOutputPath]);

  return withCommercialOutputLocks([outputPath, summaryOutputPath], async () => {
    const overlay = await parseOverlay(overlayPath);
    const selectedLines = new Set(overlay.recordsByLine.keys());
    const [source, target] = await Promise.all([
      scanCorpus(sourceInputPath, selectedLines),
      scanCorpus(targetInputPath, selectedLines),
    ]);
    if (overlay.inputSha256 !== source.sha256) {
      throw new Error(
        `Overlay input SHA-256 ${overlay.inputSha256} does not match source ${source.sha256}`,
      );
    }
    if (source.records !== target.records) {
      throw new Error(
        `Source and target corpus record counts differ: ${source.records} vs ${target.records}`,
      );
    }

    let changedTextHashes = 0;
    const remappedRecords = overlay.records.map((record) => {
      const sourceRecord = source.selectedByLine.get(record.line) as SelectedCorpusRecord;
      const targetRecord = target.selectedByLine.get(record.line) as SelectedCorpusRecord;
      if (sourceRecord.textSha256 !== record.textSha256) {
        throw new Error(
          `Overlay text SHA-256 mismatch at source corpus line ${record.line}`,
        );
      }
      if (
        sourceRecord.contextFingerprint !== record.contextFingerprint ||
        !isDeepStrictEqual(sourceRecord.settings, record.settings) ||
        !isDeepStrictEqual(
          sourceRecord.commercialCampaignContext,
          record.commercialCampaignContext,
        )
      ) {
        throw new Error(`Overlay context mismatch at source corpus line ${record.line}`);
      }
      if (
        targetRecord.contextFingerprint !== record.contextFingerprint ||
        !isDeepStrictEqual(targetRecord.settings, record.settings) ||
        !isDeepStrictEqual(
          targetRecord.commercialCampaignContext,
          record.commercialCampaignContext,
        )
      ) {
        throw new Error(`Target context drift at corpus line ${record.line}`);
      }
      if (sourceRecord.textSha256 !== targetRecord.textSha256) {
        changedTextHashes += 1;
      }
      return {
        ...record,
        inputSha256: target.sha256,
        textSha256: targetRecord.textSha256,
      } satisfies CommercialManualOverlayRecord;
    });

    const outputBody = `${remappedRecords.map((record) => JSON.stringify(record)).join('\n')}\n`;
    const summary: CommercialManualOverlayRemapSummary = {
      schemaVersion: COMMERCIAL_MANUAL_OVERLAY_REMAP_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      source: {
        path: source.path,
        sha256: source.sha256,
        records: source.records,
      },
      target: {
        path: target.path,
        sha256: target.sha256,
        records: target.records,
      },
      overlay: {
        path: overlay.path,
        sha256: overlay.sha256,
        records: overlay.records.length,
      },
      validation: {
        sourceTextHashes: remappedRecords.length,
        contextFingerprints: remappedRecords.length,
        changedTextHashes,
      },
      output: {
        path: outputPath,
        sha256: sha256(outputBody),
        records: remappedRecords.length,
        mode: '0600',
        publication: 'atomic-hard-link-no-clobber',
      },
    };
    await publishNoClobberPair({
      outputPath,
      outputBody,
      summaryOutputPath,
      summaryBody: `${JSON.stringify(summary, null, 2)}\n`,
    });
    return summary;
  });
}
