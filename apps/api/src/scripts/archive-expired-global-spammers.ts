import { GlobalSpammerIntelligenceService } from '../moderation/global-spammer-intelligence.service';
import { createPrismaClient } from '../prisma/prisma-client';

type CliOptions = {
  limit: number;
  dryRun: boolean;
  json: boolean;
};

const DEFAULT_LIMIT = 1000;

function readCliOptions(argv: readonly string[]): CliOptions {
  return {
    limit: readPositiveIntOption(argv, '--limit') ?? DEFAULT_LIMIT,
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
  };
}

function readPositiveIntOption(args: readonly string[], name: string): number | undefined {
  const value = readOptionValue(args, name);
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function readOptionValue(args: readonly string[], name: string): string | undefined {
  const index = args.findIndex((arg) => arg === name);
  if (index < 0) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

async function main() {
  const options = readCliOptions(process.argv.slice(2));
  const prisma = createPrismaClient();
  try {
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    const result = await service.archiveExpiredRegistryEntries({
      limit: options.limit,
      dryRun: options.dryRun,
    });

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
