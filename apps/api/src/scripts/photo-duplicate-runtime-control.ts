import { ConfigService } from '@nestjs/config';

import {
  PhotoDuplicateRuntimePolicyService,
  type PhotoDuplicateRuntimeControlSnapshot,
  type PhotoDuplicateRuntimeControlV1,
} from '../moderation/photo-duplicate/photo-duplicate-runtime-policy.service';

const MAX_CONTROL_JSON_BYTES = 32 * 1024;

export const PHOTO_DUPLICATE_RUNTIME_CONTROL_USAGE = [
  'Usage:',
  '  get [--json]',
  '  set --expected-revision <none|n> --control-json <json> [--apply] [--json]',
  '  clear --expected-revision <n> [--apply] [--json]',
  '',
  'Set and clear are previews unless --apply is present.',
  'The control JSON is strict v1 data and must not contain secrets.',
  'Set uses revision 1 with expected revision none, then increments exactly once per CAS.',
  'Clear and expiry preserve the revision fence; read it with get before the next set.',
  'Clearing the key is downgrade-only: potential env enforcement becomes shadow.',
].join('\n');

export type PhotoDuplicateRuntimeControlCliOptions =
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

type PhotoDuplicateRuntimeControlOperator = Pick<
  PhotoDuplicateRuntimePolicyService,
  'clearControl' | 'getControlSnapshot' | 'previewSetControl' | 'setControl'
>;

export type PhotoDuplicateRuntimeControlCommandResult = {
  command: 'get' | 'set' | 'clear';
  apply: boolean;
  complete: boolean;
  before: PhotoDuplicateRuntimeControlSnapshot;
  proposedControl?: PhotoDuplicateRuntimeControlV1;
  result:
    | { kind: 'read' }
    | { kind: 'preview'; expectedRevision: number | null; wouldMatch: boolean }
    | Awaited<ReturnType<PhotoDuplicateRuntimePolicyService['setControl']>>
    | Awaited<ReturnType<PhotoDuplicateRuntimePolicyService['clearControl']>>;
};

export function readPhotoDuplicateRuntimeControlOptions(
  argv: readonly string[],
): PhotoDuplicateRuntimeControlCliOptions {
  const command = argv[0];
  if (command === '--help' || command === '-h') {
    throw new Error(PHOTO_DUPLICATE_RUNTIME_CONTROL_USAGE);
  }
  if (command !== 'get' && command !== 'set' && command !== 'clear') {
    throw new Error(PHOTO_DUPLICATE_RUNTIME_CONTROL_USAGE);
  }

  let apply = false;
  let explicitDryRun = false;
  let json = false;
  let expectedRevisionRaw: string | null = null;
  let controlJson: string | null = null;
  const seenValueOptions = new Set<string>();

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
      throw new Error(PHOTO_DUPLICATE_RUNTIME_CONTROL_USAGE);
    }
    if (argument === '--expected-revision' || argument === '--control-json') {
      if (seenValueOptions.has(argument)) {
        throw new Error(`${argument} must be provided exactly once`);
      }
      seenValueOptions.add(argument);
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
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
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

export async function runPhotoDuplicateRuntimeControlCommand(
  operator: PhotoDuplicateRuntimeControlOperator,
  options: PhotoDuplicateRuntimeControlCliOptions,
): Promise<PhotoDuplicateRuntimeControlCommandResult> {
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

  const currentRevision = before.revision;
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
          wouldMatch: currentRevision === options.expectedRevision,
        },
      };
    }
    const result = await operator.setControl({
      expectedRevision: options.expectedRevision,
      control: proposedControl,
    });
    return {
      command: 'set',
      apply: true,
      complete: result.kind === 'applied',
      before,
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
        wouldMatch: currentRevision === options.expectedRevision,
      },
    };
  }
  const result = await operator.clearControl({ expectedRevision: options.expectedRevision });
  return {
    command: 'clear',
    apply: true,
    complete: result.kind === 'cleared',
    before,
    result,
  };
}

export function serializePhotoDuplicateRuntimeControlResult(
  result: PhotoDuplicateRuntimeControlCommandResult,
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
  const options = readPhotoDuplicateRuntimeControlOptions(process.argv.slice(2));
  const service = new PhotoDuplicateRuntimePolicyService(new ConfigService(process.env));
  try {
    const result = await runPhotoDuplicateRuntimeControlCommand(service, options);
    process.stdout.write(serializePhotoDuplicateRuntimeControlResult(result, options.json));
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
