import { ConfigService } from '@nestjs/config';
import { isDeepStrictEqual } from 'node:util';

import {
  CommercialOcrRuntimePolicyService,
  type CommercialOcrRuntimeControlSnapshot,
  type CommercialOcrRuntimeControlV1,
} from '../moderation/commercial-ocr/commercial-ocr-runtime-policy.service';

const MAX_CONTROL_JSON_BYTES = 32 * 1024;

export const COMMERCIAL_OCR_RUNTIME_CONTROL_USAGE = [
  'Usage:',
  '  get [--json]',
  '  set --expected-revision <none|n> --control-json <json> [--apply] [--json]',
  '  clear --expected-revision <n> [--apply] [--json]',
  '',
  'Set and clear are previews unless --apply is present.',
  'The strict v1 control must use exact chat ids and expire within 24 hours.',
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
  let controlJson: string | null = null;
  const seen = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      apply = true;
      continue;
    }
    if (argument === '--dry-run') {
      explicitDryRun = true;
      continue;
    }
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      throw new Error(COMMERCIAL_OCR_RUNTIME_CONTROL_USAGE);
    }
    if (argument !== '--expected-revision' && argument !== '--control-json') {
      throw new Error(`Unknown option: ${argument}`);
    }
    if (seen.has(argument)) {
      throw new Error(`${argument} must be provided exactly once`);
    }
    seen.add(argument);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`);
    }
    if (argument === '--expected-revision') {
      expectedRevisionRaw = value;
    } else {
      controlJson = value;
    }
    index += 1;
  }

  if (apply && explicitDryRun) {
    throw new Error('--apply cannot be combined with --dry-run');
  }
  if (command === 'get') {
    if (apply || explicitDryRun || expectedRevisionRaw !== null || controlJson !== null) {
      throw new Error('get accepts only --json');
    }
    return { command, json };
  }
  if (expectedRevisionRaw === null) {
    throw new Error(`${command} requires --expected-revision`);
  }
  if (command === 'clear') {
    if (controlJson !== null) {
      throw new Error('clear does not accept --control-json');
    }
    return {
      command,
      apply,
      json,
      expectedRevision: parseExpectedRevision(expectedRevisionRaw, false),
    };
  }
  if (controlJson === null) {
    throw new Error('set requires --control-json');
  }
  if (Buffer.byteLength(controlJson, 'utf8') > MAX_CONTROL_JSON_BYTES) {
    throw new Error(`--control-json must be at most ${MAX_CONTROL_JSON_BYTES} bytes`);
  }
  let control: unknown;
  try {
    control = JSON.parse(controlJson);
  } catch {
    throw new Error('--control-json must contain valid JSON');
  }
  return {
    command,
    apply,
    json,
    expectedRevision: parseExpectedRevision(expectedRevisionRaw, true),
    control,
  };
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
  return `${JSON.stringify(result, null, pretty ? 2 : 0)}\n`;
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
  if (!Number.isSafeInteger(revision)) {
    throw new Error('--expected-revision must be a positive safe integer');
  }
  return revision;
}

async function main(): Promise<void> {
  const options = readCommercialOcrRuntimeControlOptions(process.argv.slice(2));
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
