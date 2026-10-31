import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import type { MaxClientService } from '../max/max-client.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { PublisherActionCredentialService } from './publisher-action-credential.service';
import type { PublisherDispatchHealthService } from './publisher-dispatch-health.service';
import type { PublisherIdentityAttestationService } from './publisher-identity-attestation.service';
import type { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';

type FixtureCase = 'forwarded' | 'invalid-source';
type WarningObservation = { name: string; message: string; stack?: string };
type FixtureReceipt = {
  scenario: FixtureCase;
  outcome: 'committed' | 'refused';
  probes: { bot: number; actor: number; snapshot: number };
  policyStayedDisabled: boolean;
  warnings: WarningObservation[];
};

const workerCase = process.env.MAXIM_PUBLISHER_PG_FIXTURE;
const queuedClientWarning =
  'Calling client.query() when the client is already executing a query is deprecated';

async function runFixture(scenario: FixtureCase): Promise<FixtureReceipt> {
  assert.notEqual(process.noDeprecation, true, 'Driver deprecation warnings must remain enabled');
  const warnings: WarningObservation[] = [];
  const observeWarning = (warning: Error) => {
    warnings.push({ name: warning.name, message: warning.message, stack: warning.stack });
  };
  // FLAG: pg deduplicates deprecations per loaded module. Observe the real process
  // before importing the production adapter, once in each fresh fixture child.
  process.on('warning', observeWarning);
  const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
  const database = new URL(databaseUrl);
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) &&
      database.pathname.includes('race_test'),
    'Disposable local race_test PostgreSQL required',
  );
  const { createPrismaClient, Prisma } = await import('../prisma/prisma-client');
  const { PublisherBindingRefreshService } = await import('./publisher-binding-refresh.service');
  const token = BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`) + 1n;
  const chatId = `-${token}`;
  const userId = `${token + 1n}`;
  const privateChatId = `${token + 2n}`;
  const botId = `publisher-pg-${randomUUID()}`;
  const updateId = randomUUID();
  const dedupKey = `${botId}:${updateId}`;
  const candidateVersion = `forwarded:${updateId}`;
  const probes = { bot: 0, actor: 0, snapshot: 0 };
  const db = createPrismaClient(databaseUrl, {
    max: 2,
    application_name: `publisher-pg-${randomUUID()}`,
    statement_timeout: 10_000,
  });
  let receipt: FixtureReceipt;
  try {
    await db.$connect();
    const server = await db.$queryRaw<Array<{ version: string; timezone: string }>>(Prisma.sql`
      SELECT version() AS version, current_setting('TimeZone') AS timezone
    `);
    assert.match(server[0]!.version, /^PostgreSQL 16\./u);
    assert.equal(server[0]!.timezone, 'UTC');
    const sourceAt = new Date(Date.now() - 1_000);
    await db.chat.create({ data: { id: chatId, title: 'Publisher PG fixture' } });
    const policy = await db.managedEntityPublicationPolicy.create({
      data: { chatId, publikEnabled: false },
    });
    await db.managedEntityAccessEdge.create({
      data: {
        chatId,
        userId,
        botId,
        state: 'BOT_DENIED',
        source: 'publisher_actor_candidate_forwarded',
        sourceVersion: candidateVersion,
        checkedAt: new Date(sourceAt.getTime() - 1_000),
      },
    });
    const raw = {
      update_type: 'message_created',
      message: {
        id: 'incoming',
        sender: { user_id: userId },
        recipient: { chat_id: privateChatId, chat_type: 'dialog' },
        body: null,
        link: {
          type: 'forward',
          chat_id: scenario === 'invalid-source' ? '-1' : chatId,
          message: { mid: 'source', text: 'Synthetic fixture' },
        },
      },
    };
    await db.webhookEvent.create({
      data: {
        dedupKey,
        botId,
        rawPayload: raw,
        normalizedPayload: {
          botId,
          updateId,
          type: 'message_created',
          eventTimestampSource: 'payload',
          message: {
            chatId: privateChatId,
            senderId: userId,
            messageId: 'incoming',
            text: '',
            createdAt: sourceAt.toISOString(),
          },
          raw,
        },
      },
    });
    // FLAG: Only external boundaries are faked. The public refresh, exact persisted
    // activation, chat lock, transaction and all authority writes use the real adapter.
    const maxClient: Pick<
      MaxClientService,
      'getCurrentChatMemberAccess' | 'getChatMemberAccess' | 'getChatSnapshot'
    > = {
      async getCurrentChatMemberAccess(actualChatId, options) {
        assert.equal(actualChatId, chatId);
        assert.equal(options?.botId, botId);
        assert.equal(options?.bypassCache, true);
        assert.equal(options?.explicitActivation?.updateId, updateId);
        probes.bot++;
        return {
          userId: null,
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
          permissionsKnown: true,
          explicitPrivilegeEvidence: true,
        };
      },
      async getChatMemberAccess(actualChatId, actualUserId, options) {
        assert.equal(actualChatId, chatId);
        assert.equal(actualUserId, userId);
        assert.equal(options?.botId, botId);
        assert.equal(options?.bypassCache, true);
        probes.actor++;
        return {
          userId,
          isBot: false,
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
          permissionsKnown: true,
          explicitPrivilegeEvidence: true,
        };
      },
      async getChatSnapshot(actualChatId, options) {
        assert.equal(actualChatId, chatId);
        assert.equal(options?.botId, botId);
        assert.equal(options?.bypassCache, true);
        probes.snapshot++;
        return {
          chatId,
          title: 'Publisher PG fixture',
          entityType: 'chat',
          participantsCount: null,
          status: null,
          isPublic: null,
          link: null,
          lastEventAt: null,
          avatarUrl: null,
        };
      },
    };
    const credentials: Pick<
      PublisherActionCredentialService,
      'getBotId' | 'getRequiredActionToken'
    > = {
      getBotId: () => botId,
      getRequiredActionToken: (actualBotId) => {
        assert.equal(actualBotId, botId);
        return 'synthetic';
      },
    };
    const health: Pick<
      PublisherDispatchHealthService,
      | 'assertDispatchAllowed'
      | 'isGloballyPaused'
      | 'recordAuthenticatedSuccess'
      | 'recordGlobalAuthorizationFailure'
    > = {
      assertDispatchAllowed: async () => {},
      isGloballyPaused: async () => false,
      recordAuthenticatedSuccess: async () => {},
      recordGlobalAuthorizationFailure: async () => {
        assert.fail('Unexpected global authorization failure');
      },
    };
    const identity: Pick<PublisherIdentityAttestationService, 'assertAttested'> = {
      assertAttested: async () => {},
    };
    const runtime: Pick<
      PublisherRuntimeBoundaryService,
      'dispatchEnabled' | 'assertDispatchEnabled'
    > = {
      dispatchEnabled: true,
      assertDispatchEnabled: () => {},
    };
    const links: Pick<MaxBotLinkService, 'buildMiniappStartUrlSync'> = {
      buildMiniappStartUrlSync: () => assert.fail('Unexpected interactive reply'),
    };
    const service = new PublisherBindingRefreshService(
      db as PrismaService,
      maxClient as MaxClientService,
      credentials as PublisherActionCredentialService,
      health as PublisherDispatchHealthService,
      identity as PublisherIdentityAttestationService,
      runtime as PublisherRuntimeBoundaryService,
      links as MaxBotLinkService,
    );
    await service.refresh({
      version: 1,
      chatId,
      publisherBotId: botId,
      candidateUserId: userId,
      candidateVersion,
      activationSourceAt: sourceAt.toISOString(),
      reason: 'forwarded_private',
      requestedAt: sourceAt.toISOString(),
    });
    const edge = await db.managedEntityAccessEdge.findUniqueOrThrow({
      where: { chatId_userId_botId: { chatId, userId, botId } },
    });
    const binding = await db.publisherEntityBinding.findUnique({ where: { chatId } });
    const catalog = await db.managedBotChatCatalog.findUnique({
      where: { botId_chatId: { botId, chatId } },
    });
    if (scenario === 'forwarded') {
      assert.deepEqual(probes, { bot: 1, actor: 1, snapshot: 1 });
      assert.equal(edge.state, 'GRANTED');
      assert.equal(edge.userRole, 'ADMIN');
      assert.equal(edge.source, 'publisher_targeted_user_access');
      assert.equal(edge.sourceVersion, candidateVersion);
      assert.equal(binding?.publisherBotId, botId);
      assert.equal(binding?.status, 'ACTIVE');
      assert.equal(binding?.botAccessState, 'CONFIRMED_ADMIN');
      assert.equal(binding?.botAccessSource, 'publisher_refresh_forwarded_private');
      assert.equal(catalog?.status, 'ACTIVE');
      assert.equal(catalog?.source, 'publisher_targeted_snapshot');
    } else {
      assert.deepEqual(probes, { bot: 0, actor: 0, snapshot: 0 });
      assert.equal(edge.state, 'BOT_DENIED');
      assert.equal(edge.source, 'publisher_actor_candidate_forwarded');
      assert.equal(binding, null);
      assert.equal(catalog, null);
    }
    assert.deepEqual(
      await db.managedEntityPublicationPolicy.findUnique({ where: { chatId } }),
      policy,
    );
    const chat = await db.chat.findUniqueOrThrow({ where: { id: chatId } });
    assert.equal(chat.botId, null);
    assert.equal(chat.primaryBotId, null);
    assert.equal(await db.chatBotMembership.count({ where: { chatId } }), 0);
    await nextTurn();
    receipt = {
      scenario,
      outcome: scenario === 'forwarded' ? 'committed' : 'refused',
      probes,
      policyStayedDisabled: true,
      warnings,
    };
  } finally {
    await db.webhookEvent.deleteMany({ where: { dedupKey } });
    await db.managedBotChatCatalog.deleteMany({ where: { botId, chatId } });
    await db.chat.deleteMany({ where: { id: chatId } });
    await db.$disconnect();
    await nextTurn();
    process.removeListener('warning', observeWarning);
  }
  return receipt;
}

if (workerCase === 'forwarded' || workerCase === 'invalid-source') {
  void runFixture(workerCase)
    .then(
      async (receipt) => {
        await new Promise<void>((done, reject) => {
          process.send!(receipt, (error) => (error ? reject(error) : done()));
        });
      },
      (error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      },
    )
    .finally(() => process.disconnect?.());
} else {
  const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
  const integration = databaseUrl ? describe : describe.skip;
  integration('Publisher public activation PostgreSQL query flow', () => {
    it.each(['forwarded', 'invalid-source'] as const)(
      'retains exact activation and disabled publishing without queued-client warnings: %s',
      async (scenario) => {
        const child = fork(__filename, [], {
          cwd: resolve(__dirname, '../..'),
          execArgv: ['--import', require.resolve('tsx')],
          env: {
            ...process.env,
            TZ: 'UTC',
            TSX_TSCONFIG_PATH: resolve(__dirname, '../../tsconfig.json'),
            MAXIM_PUBLISHER_PG_FIXTURE: scenario,
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        const receipts: FixtureReceipt[] = [];
        let output = '';
        let timedOut = false;
        for (const stream of [child.stdout, child.stderr])
          stream?.on('data', (chunk: Buffer) => {
            output = (output + chunk.toString()).slice(-16_384);
          });
        child.on('message', (message: FixtureReceipt) => receipts.push(message));
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, 30_000);
        const terminal = await new Promise<{ code: number | null; signal: string | null }>(
          (done, reject) => {
            child.once('error', reject);
            child.once('close', (code, signal) => done({ code, signal }));
          },
        ).finally(() => clearTimeout(timer));
        const diagnostic = JSON.stringify(
          { scenario, terminal, timedOut, receipts, output },
          null,
          2,
        );
        assert.equal(timedOut, false, diagnostic);
        assert.deepEqual(terminal, { code: 0, signal: null }, diagnostic);
        assert.equal(receipts.length, 1, diagnostic);
        const receipt = receipts[0]!;
        assert.equal(receipt.scenario, scenario, diagnostic);
        assert.equal(
          receipt.outcome,
          scenario === 'forwarded' ? 'committed' : 'refused',
          diagnostic,
        );
        assert.equal(receipt.policyStayedDisabled, true, diagnostic);
        assert.equal(
          receipt.warnings.filter((warning) => warning.message.includes(queuedClientWarning))
            .length,
          0,
          diagnostic,
        );
        assert.ok(!output.includes(queuedClientWarning), diagnostic);
      },
      40_000,
    );
  });
}
