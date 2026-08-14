import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  COMMERCIAL_OCR_MAX_PROMOTABLE_EXPECTED_REVISION,
  CommercialOcrRuntimePolicyService,
  type CommercialOcrRuntimeControlSnapshot,
  type CommercialOcrRuntimeControlV1,
} from '../moderation/commercial-ocr/commercial-ocr-runtime-policy.service';

const MAX_CONTROL_JSON_BYTES = 32 * 1024;

export const COMMERCIAL_OCR_RUNTIME_CONTROL_USAGE = [
  'Usage:',
  '  get [--json]',
  '  set --expected-revision <none|n> --control-stdin [--apply] [--json]',
  '  clear --expected-revision <n> [--apply] [--json]',
  '',
  'Set and clear are previews unless --apply is present.',
  'The strict v1 control must bind one certification and approval key, certified settings, exact chat ids, and expire within 24 hours.',
  'Clearing or expiry revokes OCR enforcement and leaves env shadow processing available.',
].join('\n');

export type CommercialOcrRuntimeControlCliOptions =
  | { command: 'get'; json: boolean }
  | {
      command: 'set';
      apply: boolean;
      json: boolean;
      expectedRevision: number | null;
      control: unknown;
    }
  | {
      command: 'clear';
      apply: boolean;
      json: boolean;
      expectedRevision: number;
    };

type Operator = Pick<
  CommercialOcrRuntimePolicyService,
  'clearControl' | 'getControlSnapshot' | 'previewSetControl' | 'setControl'
>;

export type CommercialOcrRuntimeControlCommandResult = {
  command: 'get' | 'set' | 'clear';
  apply: boolean;
  complete: boolean;
  before: CommercialOcrRuntimeControlSnapshot;
  after?: CommercialOcrRuntimeControlSnapshot;
  proposedControl?: CommercialOcrRuntimeControlV1;
  result:
    | { kind: 'read' }
    | { kind: 'preview'; expectedRevision: number | null; wouldMatch: boolean }
    | Awaited<ReturnType<CommercialOcrRuntimePolicyService['setControl']>>
    | Awaited<ReturnType<CommercialOcrRuntimePolicyService['clearControl']>>;
};

export function readCommercialOcrRuntimeControlOptions(
  argv: readonly string[],
  controlStdin?: string,
): CommercialOcrRuntimeControlCliOptions {
  const command = argv[0];
  if (command === '--help' || command === '-h') {
    throw new Error(COMMERCIAL_OCR_RUNTIME_CONTROL_USAGE);
  }
  if (command !== 'get' && command !== 'set' && command !== 'clear') {
    throw new Error(COMMERCIAL_OCR_RUNTIME_CONTROL_USAGE);
  }

  let apply = false;
  let explicitDryRun = false;
  let json = false;
  let expectedRevisionRaw: string | null = null;
  let controlFromStdin = false;
  const seen = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      if (seen.has(argument)) {
        throw new Error(`${argument} must be provided exactly once`);
      }
      seen.add(argument);
      apply = true;
      continue;
    }
    if (argument === '--dry-run') {
      if (seen.has(argument)) {
        throw new Error(`${argument} must be provided exactly once`);
      }
      seen.add(argument);
      explicitDryRun = true;
      continue;
    }
    if (argument === '--json') {
      if (seen.has(argument)) {
        throw new Error(`${argument} must be provided exactly once`);
      }
      seen.add(argument);
      json = true;
      continue;
    }
    if (argument === '--control-stdin') {
      if (seen.has(argument)) {
        throw new Error('--control-stdin must be provided exactly once');
      }
      seen.add(argument);
      controlFromStdin = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      throw new Error(COMMERCIAL_OCR_RUNTIME_CONTROL_USAGE);
    }
    if (argument === '--control-json') {
      throw new Error('--control-json is forbidden; pass control JSON via --control-stdin');
    }
    if (argument !== '--expected-revision') {
      throw new Error('Unknown option; see --help for supported arguments');
    }
    if (seen.has(argument)) {
      throw new Error(`${argument} must be provided exactly once`);
    }
    seen.add(argument);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`);
    }
    expectedRevisionRaw = value;
    index += 1;
  }

  if (apply && explicitDryRun) {
    throw new Error('--apply cannot be combined with --dry-run');
  }
  if (command === 'get') {
    if (apply || explicitDryRun || expectedRevisionRaw !== null || controlFromStdin) {
      throw new Error('get accepts only --json');
    }
    return { command, json };
  }
  if (expectedRevisionRaw === null) {
    throw new Error(`${command} requires --expected-revision`);
  }
  if (command === 'clear') {
    if (controlFromStdin) {
      throw new Error('clear does not accept control JSON');
    }
    return {
      command,
      apply,
      json,
      expectedRevision: parseExpectedRevision(expectedRevisionRaw, false),
    };
  }
  if (!controlFromStdin) {
    throw new Error('set requires --control-stdin');
  }
  if (controlStdin === undefined) {
    throw new Error('--control-stdin requires JSON on standard input');
  }
  if (Buffer.byteLength(controlStdin, 'utf8') > MAX_CONTROL_JSON_BYTES) {
    throw new Error(`standard input must be at most ${MAX_CONTROL_JSON_BYTES} bytes`);
  }
  let control: unknown;
  try {
    control = JSON.parse(controlStdin);
  } catch {
    throw new Error('standard input must contain valid JSON');
  }
  return {
    command,
    apply,
    json,
    expectedRevision: parseExpectedRevision(expectedRevisionRaw, true),
    control,
  };
}

export async function readCommercialOcrRuntimeControlStdin(
  input: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    byteLength += buffer.byteLength;
    if (byteLength > MAX_CONTROL_JSON_BYTES) {
      throw new Error(`standard input must be at most ${MAX_CONTROL_JSON_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function runCommercialOcrRuntimeControlCommand(
  operator: Operator,
  options: CommercialOcrRuntimeControlCliOptions,
): Promise<CommercialOcrRuntimeControlCommandResult> {
  const before = await operator.getControlSnapshot();
  if (options.command === 'get') {
    return {
      command: 'get',
      apply: false,
      complete: before.kind !== 'invalid',
      before,
      result: { kind: 'read' },
    };
  }
  if (options.command === 'set') {
    const proposedControl = operator.previewSetControl({
      expectedRevision: options.expectedRevision,
      control: options.control,
    });
    if (!options.apply) {
      return {
        command: 'set',
        apply: false,
        complete: true,
        before,
        proposedControl,
        result: {
          kind: 'preview',
          expectedRevision: options.expectedRevision,
          wouldMatch: before.revision === options.expectedRevision,
        },
      };
    }
    const attempt = await operator.setControl({
      expectedRevision: options.expectedRevision,
      control: proposedControl,
    });
    const after = await readPostMutationSnapshot(operator, 'set');
    const verifiedApplied = isVerifiedSet(after, proposedControl);
    const result = reconcileSetAttempt({
      attempt,
      after,
      expectedRevision: options.expectedRevision,
      proposedControl,
    });
    return {
      command: 'set',
      apply: true,
      complete: result.kind === 'applied' && verifiedApplied,
      before,
      after,
      proposedControl,
      result,
    };
  }
  if (!options.apply) {
    return {
      command: 'clear',
      apply: false,
      complete: true,
      before,
      result: {
        kind: 'preview',
        expectedRevision: options.expectedRevision,
        wouldMatch: before.revision === options.expectedRevision,
      },
    };
  }
  const attempt = await operator.clearControl({ expectedRevision: options.expectedRevision });
  const after = await readPostMutationSnapshot(operator, 'clear');
  const verifiedCleared = isVerifiedClear(after, options.expectedRevision);
  const result = reconcileClearAttempt({
    attempt,
    after,
    expectedRevision: options.expectedRevision,
  });
  return {
    command: 'clear',
    apply: true,
    complete: result.kind === 'cleared' && verifiedCleared,
    before,
    after,
    result,
  };
}

async function readPostMutationSnapshot(
  operator: Operator,
  command: 'set' | 'clear',
): Promise<CommercialOcrRuntimeControlSnapshot> {
  try {
    return await operator.getControlSnapshot();
  } catch (error: unknown) {
    throw new Error(
      `Commercial OCR runtime control ${command} outcome could not be verified after mutation`,
      { cause: error },
    );
  }
}

function isVerifiedSet(
  snapshot: CommercialOcrRuntimeControlSnapshot,
  proposedControl: CommercialOcrRuntimeControlV1,
): boolean {
  return (
    snapshot.kind === 'active' &&
    snapshot.revision === proposedControl.revision &&
    isDeepStrictEqual(snapshot.control, proposedControl)
  );
}

function isVerifiedClear(
  snapshot: CommercialOcrRuntimeControlSnapshot,
  expectedRevision: number,
): boolean {
  return snapshot.kind === 'missing' && snapshot.revision === expectedRevision + 1;
}

function reconcileSetAttempt(params: {
  attempt: Awaited<ReturnType<CommercialOcrRuntimePolicyService['setControl']>>;
  after: CommercialOcrRuntimeControlSnapshot;
  expectedRevision: number | null;
  proposedControl: CommercialOcrRuntimeControlV1;
}): Awaited<ReturnType<CommercialOcrRuntimePolicyService['setControl']>> {
  if (params.attempt.kind !== 'ambiguous') {
    return params.attempt;
  }
  if (isVerifiedSet(params.after, params.proposedControl)) {
    return {
      kind: 'applied',
      revision: params.proposedControl.revision,
      expiresAt: params.proposedControl.expiresAt,
    };
  }
  if (
    (params.after.kind === 'active' || params.after.kind === 'expired') &&
    params.after.revision === params.proposedControl.revision &&
    !isDeepStrictEqual(params.after.control, params.proposedControl)
  ) {
    return { kind: 'conflict', currentRevision: params.after.revision };
  }
  return params.attempt;
}

function reconcileClearAttempt(params: {
  attempt: Awaited<ReturnType<CommercialOcrRuntimePolicyService['clearControl']>>;
  after: CommercialOcrRuntimeControlSnapshot;
  expectedRevision: number;
}): Awaited<ReturnType<CommercialOcrRuntimePolicyService['clearControl']>> {
  if (params.attempt.kind !== 'ambiguous') {
    return params.attempt;
  }
  if (isVerifiedClear(params.after, params.expectedRevision)) {
    return {
      kind: 'cleared',
      previousRevision: params.expectedRevision,
      revision: params.expectedRevision + 1,
    };
  }
  if (
    (params.after.kind === 'active' || params.after.kind === 'expired') &&
    params.after.revision === params.expectedRevision + 1
  ) {
    return { kind: 'conflict', currentRevision: params.after.revision };
  }
  return params.attempt;
}

export function serializeCommercialOcrRuntimeControlResult(
  result: CommercialOcrRuntimeControlCommandResult,
  pretty: boolean,
): string {
  const snapshot =
    result.command === 'get' || result.after === undefined ? result.before : result.after;
  const summary = summarizeSnapshotForOutput(snapshot);
  return `${JSON.stringify(
    {
      command: result.command,
      apply: result.apply,
      complete: result.complete,
      resultKind: result.result.kind,
      beforeKind: result.before.kind,
      ...summary,
    },
    null,
    pretty ? 2 : 0,
  )}\n`;
}

function summarizeSnapshotForOutput(snapshot: CommercialOcrRuntimeControlSnapshot): {
  kind: CommercialOcrRuntimeControlSnapshot['kind'];
  revision: number | null;
  mode: CommercialOcrRuntimeControlV1['mode'] | null;
  chatCount: number;
  chatDigest: string | null;
  expiresAt: string | null;
} {
  if (snapshot.control === null) {
    return {
      kind: snapshot.kind,
      revision: snapshot.revision,
      mode: null,
      chatCount: 0,
      chatDigest: null,
      expiresAt: null,
    };
  }
  const chatIds = [...snapshot.control.enforcementChatIds];
  const allChatIdsUseRolloutFormat = chatIds.every((chatId) => /^-?[1-9]\d{0,18}$/u.test(chatId));
  chatIds.sort(allChatIdsUseRolloutFormat ? compareIntegerStrings : compareStrings);
  return {
    kind: snapshot.kind,
    revision: snapshot.revision,
    mode: snapshot.control.mode,
    chatCount: chatIds.length,
    chatDigest: createHash('sha256')
      .update(`${chatIds.join('\n')}\n`)
      .digest('hex'),
    expiresAt: snapshot.control.expiresAt,
  };
}

function compareIntegerStrings(left: string, right: string): number {
  const leftNegative = left.startsWith('-');
  const rightNegative = right.startsWith('-');
  if (leftNegative !== rightNegative) {
    return leftNegative ? -1 : 1;
  }
  const leftDigits = leftNegative ? left.slice(1) : left;
  const rightDigits = rightNegative ? right.slice(1) : right;
  if (leftDigits.length !== rightDigits.length) {
    const order = leftDigits.length - rightDigits.length;
    return leftNegative ? -order : order;
  }
  const order = leftDigits.localeCompare(rightDigits);
  return leftNegative ? -order : order;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseExpectedRevision(value: string, allowNone: true): number | null;
function parseExpectedRevision(value: string, allowNone: false): number;
function parseExpectedRevision(value: string, allowNone: boolean): number | null {
  if (allowNone && value === 'none') {
    return null;
  }
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error('--expected-revision must be a positive safe integer');
  }
  const revision = Number(value);
  const maximum = allowNone
    ? COMMERCIAL_OCR_MAX_PROMOTABLE_EXPECTED_REVISION
    : Number.MAX_SAFE_INTEGER - 1;
  if (!Number.isSafeInteger(revision) || revision > maximum) {
    throw new Error('--expected-revision is outside the supported mutation range');
  }
  return revision;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const controlStdin = argv.includes('--control-stdin')
    ? await readCommercialOcrRuntimeControlStdin()
    : undefined;
  const options = readCommercialOcrRuntimeControlOptions(argv, controlStdin);
  const service = new CommercialOcrRuntimePolicyService(new ConfigService(process.env));
  try {
    const result = await runCommercialOcrRuntimeControlCommand(service, options);
    process.stdout.write(serializeCommercialOcrRuntimeControlResult(result, options.json));
    if (!result.complete) {
      process.exitCode = 2;
    }
  } finally {
    await service.onModuleDestroy();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
