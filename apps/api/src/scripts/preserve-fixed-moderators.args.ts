import { parseArgs } from 'node:util';

export function parseModeratorPreservationArgs(argv: readonly string[]) {
  const args: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const next = argv[index + 1];
    // FLAG: MAX community IDs are signed decimal strings. Node treats a separate
    // negative value as another option; preserve its exact digits without relaxing
    // strict option parsing or consuming a following flag as an identifier.
    if (
      (argument === '--explain-chat' || argument === '--after') &&
      next !== undefined &&
      /^-\d+$/u.test(next)
    ) {
      args.push(`${argument}=${next}`);
      index += 1;
    } else {
      args.push(argument);
    }
  }
  return parseArgs({
    args,
    options: {
      apply: { type: 'boolean', default: false },
      'explain-chat': { type: 'string' },
      'source-sha': { type: 'string' },
      'reviewed-digest': { type: 'string' },
      after: { type: 'string' },
      limit: { type: 'string', default: '25' },
    },
  }).values;
}
