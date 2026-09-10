import { ConfigService } from '@nestjs/config';
import { parseArgs } from 'node:util';
import { RedisCounterService } from '../moderation/redis-counter.service';
import {
  MessageDuplicatePolicyService,
  messageDuplicateControlSchema,
} from '../moderation/message-duplicate/message-duplicate-policy.service';

export function parseMessageDuplicateControlOptions(argv: string[], now = Date.now()) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      apply: { type: 'boolean' },
      'expected-revision': { type: 'string' },
      'chat-id': { type: 'string', multiple: true },
      mode: { type: 'string' },
      'ttl-hours': { type: 'string' },
      'all-enabled-chats': { type: 'boolean' },
      permanent: { type: 'boolean' },
    },
  });
  const command = positionals[0];
  if (positionals.length !== 1 || !['get', 'set', 'off'].includes(command ?? ''))
    throw new Error(
      'Usage: get | set --expected-revision <0..n> (--chat-id=<-id> | --all-enabled-chats) --mode <shadow|delete_only|full> (--ttl-hours <1..24> | --permanent) [--apply] | off --expected-revision <n> [--apply]',
    );
  if (command === 'get') {
    if (Object.keys(values).length) throw new Error('get accepts no options');
    return { command: 'get' as const };
  }
  if (!/^(0|[1-9][0-9]*)$/.test(values['expected-revision'] ?? ''))
    throw new Error('Explicit revision required');
  const expectedRevision = Number(values['expected-revision']);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision >= Number.MAX_SAFE_INTEGER)
    throw new Error('Invalid revision');
  if (
    command === 'off' &&
    (values.mode ||
      values['chat-id'] ||
      values['ttl-hours'] ||
      values['all-enabled-chats'] ||
      values.permanent)
  )
    throw new Error('off accepts only revision and apply');
  const ttl = command === 'off' ? 24 : Number(values['ttl-hours']);
  const permanent = command === 'off' || values.permanent === true;
  if (values.permanent && values['ttl-hours'])
    throw new Error('Choose a finite or permanent lifetime, not both');
  const mode = command === 'off' ? 'off' : values.mode;
  if (
    (!permanent && (!Number.isInteger(ttl) || ttl < 1 || ttl > 24)) ||
    (command === 'set' && !['shadow', 'delete_only', 'full'].includes(mode ?? ''))
  )
    throw new Error('Invalid mode or lifetime');
  if (values['all-enabled-chats'] && values['chat-id']?.length)
    throw new Error('Choose one rollout scope');
  if (command === 'set' && !values['chat-id']?.length && !values['all-enabled-chats'])
    throw new Error('Explicit chat cohort required');
  const control = messageDuplicateControlSchema.parse({
    version: 2,
    revision: expectedRevision + 1,
    mode,
    scope: values['all-enabled-chats'] ? 'all_enabled_chats' : 'chats',
    chatIds: command === 'off' || values['all-enabled-chats'] ? [] : values['chat-id'],
    effectiveAt: new Date(now).toISOString(),
    expiresAt: permanent ? null : new Date(now + ttl * 3600000).toISOString(),
  });
  return {
    command: command as 'set' | 'off',
    apply: values.apply === true,
    expectedRevision,
    control,
  };
}

export async function runMessageDuplicateControlCommand(
  service: Pick<MessageDuplicatePolicyService, 'snapshot' | 'set'>,
  argv: string[],
) {
  const options = parseMessageDuplicateControlOptions(argv);
  const before = await service.snapshot();
  const status = {
    revision: before.revision,
    mode: before.control?.mode ?? 'off',
    scope: before.control?.version === 2 ? before.control.scope : 'chats',
    chatCount:
      before.control?.version === 2 && before.control.scope === 'all_enabled_chats'
        ? null
        : (before.control?.chatIds.length ?? 0),
    expiresAt: before.control?.expiresAt ?? null,
  };
  if (options.command === 'get') return { command: 'get', status };
  if (before.revision !== options.expectedRevision)
    throw new Error('Control revision conflict; inspect get again');
  if (!options.apply)
    return {
      command: options.command,
      status,
      preview: true,
      proposed: {
        revision: options.control.revision,
        mode: options.control.mode,
        scope: options.control.version === 2 ? options.control.scope : 'chats',
        chatCount:
          options.control.version === 2 && options.control.scope === 'all_enabled_chats'
            ? null
            : options.control.chatIds.length,
        expiresAt: options.control.expiresAt,
      },
    };
  const result = await service.set(options.control, options.expectedRevision);
  if (!result.applied) throw new Error('Control revision conflict; no change applied');
  return { command: options.command, applied: true, revision: result.revision };
}

async function main() {
  const config = new ConfigService(process.env);
  const redis = new RedisCounterService(config);
  try {
    const result = await runMessageDuplicateControlCommand(
      new MessageDuplicatePolicyService(redis, config),
      process.argv.slice(2),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await redis.onModuleDestroy();
  }
}
if (require.main === module)
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Control failed'}\n`);
    process.exitCode = 1;
  });
