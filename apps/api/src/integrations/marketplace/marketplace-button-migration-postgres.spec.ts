import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import type {
  MarketplaceBindingInput,
  MarketplaceEntryResponse,
} from '@maxim/contracts/marketplace-integration';
import type { ManagedEntitiesService } from '../../admin/managed-entities.service';
import type { MaxClientService } from '../../max/max-client.service';
import { PrismaClient, createPrismaAdapter } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PublisherIdentityAttestationService } from '../../publisher/publisher-identity-attestation.service';
import type { BackgroundRuntimeGovernorService } from '../../system/background-runtime-governor.service';
import { MarketplaceAccessService } from './marketplace-access.service';
import { MarketplaceButtonPolicyService } from './marketplace-button-policy.service';
import { MarketplaceStateService } from './marketplace-state.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;
const migrationName = '20261028010000_add_marketplace_button_policies';
const migrationSql = (name: string) =>
  readFileSync(resolve(__dirname, '../../../prisma/migrations', name, 'migration.sql'), 'utf8');
const migration = migrationSql(migrationName);
jest.setTimeout(30_000);

postgres.each(['moderation', 'publisher'] as const)(
  'button migration from persisted legacy %s state',
  (profile) => {
    let sql: Client;
    let db: PrismaClient;
    let schema: string;
    let state: MarketplaceStateService;
    let access: MarketplaceAccessService;
    let service: MarketplaceButtonPolicyService;
    let input: MarketplaceBindingInput;
    let entry: MarketplaceEntryResponse;
    let bindingId: string;
    let max: Pick<
      jest.Mocked<MaxClientService>,
      'getChatSnapshot' | 'getCurrentChatMemberAccess' | 'getChatMemberAccess'
    >;
    const botId = 'fixture-migration-bot';
    const actor = '938001';
    const previousRole = process.env.APP_ROLE;
    const previousService = process.env.APP_SERVICE_NAME;

    beforeEach(async () => {
      const url = new URL(databaseUrl);
      if (
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        !url.pathname.includes('race_test')
      )
        throw new Error('Disposable local race_test database required');
      schema = 'button_boundary_' + randomUUID().replaceAll('-', '');
      sql = new Client({ connectionString: databaseUrl, statement_timeout: 10_000 });
      await sql.connect();
      await sql.query(`CREATE SCHEMA "${schema}"`);
      await sql.query(`SET search_path TO "${schema}",public`);
      const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
      const enums = await sql.query<{ name: string; labels: string[] }>(
        `SELECT t.typname AS name,array_agg(e.enumlabel::text ORDER BY e.enumsortorder) labels FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid WHERE n.nspname='public' GROUP BY t.typname`,
      );
      for (const { name, labels } of enums.rows)
        await sql.query(
          `CREATE TYPE ${identifier(name)} AS ENUM (${labels.map((label) => "'" + label.replaceAll("'", "''") + "'").join(',')})`,
        );

      // FLAG: Marketplace tables are built from the actual prior SQL, before any new
      // loss trigger exists. Unchanged authorization tables copy only structure, not triggers/data.
      for (const table of [
        'chats',
        'chat_bot_memberships',
        'publisher_entity_bindings',
        'managed_entity_access_edges',
        'chat_membership_activity_events',
      ]) {
        await sql.query(`CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`);
        const columns = await sql.query<{ name: string; type: string; default: string | null }>(
          `SELECT a.attname name,t.typname type,pg_get_expr(d.adbin,d.adrelid) AS default FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped AND t.typtype='e'`,
          [table],
        );
        for (const column of columns.rows) {
          const target = `ALTER TABLE ${identifier(table)} ALTER COLUMN ${identifier(column.name)}`;
          await sql.query(`${target} DROP DEFAULT`);
          await sql.query(
            `${target} TYPE ${identifier(column.type)} USING ${identifier(column.name)}::text::${identifier(column.type)}`,
          );
          if (column.default !== null)
            await sql.query(
              `${target} SET DEFAULT (${column.default})::text::${identifier(column.type)}`,
            );
        }
      }
      for (const name of [
        '20261004120000_add_marketplace_shared_analytics',
        '20261023010000_add_statistics_exchange_v2',
        '20261023030000_preserve_explicit_statistics_revocation',
      ])
        await sql.query(migrationSql(name));
      url.searchParams.set('schema', schema);
      db = new PrismaClient({
        adapter: createPrismaAdapter(url.toString(), {
          max: 4,
          statement_timeout: 10_000,
          options: `-c search_path=${schema},public`,
        }),
      });
      await db.$connect();
      process.env.APP_ROLE = profile === 'publisher' ? 'publisher' : 'admin';
      process.env.APP_SERVICE_NAME = profile === 'publisher' ? 'api-publisher' : 'api-admin';
      const kind = profile === 'publisher' ? 'CHANNEL' : 'CHAT';
      const entityId = '-' + Date.now() + String(Math.floor(Math.random() * 10_000));
      input = { actorUserId: actor, entityId, kind, profile };
      await db.chat.create({
        data: { id: entityId, title: 'Synthetic migration platform', entityType: kind },
      });
      if (profile === 'publisher')
        await db.publisherEntityBinding.create({
          data: {
            chatId: entityId,
            publisherBotId: botId,
            status: 'ACTIVE',
            botAccessState: 'UNKNOWN',
          },
        });
      else
        await db.chatBotMembership.create({
          data: { chatId: entityId, botId, status: 'ACTIVE', botAccessState: 'UNKNOWN' },
        });
      bindingId = randomUUID();
      const listingId = randomUUID();
      entry = {
        entityId,
        kind,
        profile,
        publicState: 'PUBLIC',
        listing: {
          id: listingId,
          ownershipKey: createHash('sha256')
            .update(`birzhik-owner-v1:${listingId}:${actor}`)
            .digest('hex'),
          title: 'Synthetic migration profile',
          publicUrl: `https://max.ru/id613000037577_3_bot?startapp=listing_${kind.toLowerCase()}_${listingId}`,
          profileOnly: false,
        },
        isOwner: true,
        canCreate: false,
        manageUrl: `https://max.ru/id613000037577_3_bot?startapp=manage_${kind.toLowerCase()}_${listingId}`,
        connectUrl: `https://max.ru/id613000037577_3_bot?startapp=connect_${kind.toLowerCase()}_${entityId}`,
        checkedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 300_000).toISOString(),
      };
      await sql.query(
        `INSERT INTO marketplace_bindings(id,actor_user_id,entity_id,kind,profile,bot_id,state,checked_at,valid_until,updated_at,statistics_consent,append_enabled,append_revision,profile_snapshot,public_url,public_verified_until,history_signature,history_complete)
      VALUES($1,$2,$3,$4,$5,$6,'ACTIVE',now()-interval '1 hour',now()-interval '55 minutes',now()-interval '1 hour',true,true,7,$7::jsonb,$8,now()+interval '5 minutes','retained-history',true)`,
        [
          bindingId,
          actor,
          entityId,
          kind,
          profile,
          botId,
          JSON.stringify({ listing: { id: listingId } }),
          entry.listing!.publicUrl,
        ],
      );
      await sql.query(
        `INSERT INTO marketplace_statistics_generations(id,binding_id,manifest,rows) VALUES($1,$2,'{"fixture":true}','[{"retained":1}]');`,
        [randomUUID(), bindingId],
      );
      await sql.query(
        `INSERT INTO marketplace_post_samples(binding_id,message_id,published_at,views) VALUES($1,'synthetic-retained-post',now()-interval '1 day',12)`,
        [bindingId],
      );
      await sql.query(
        `INSERT INTO marketplace_policy_requests(request_id,binding_id,payload_hash,result) VALUES($1,$2,'legacy-receipt','{"appendEnabled":true,"appendRevision":7}')`,
        [randomUUID(), bindingId],
      );
      const config = new ConfigService({
        SVYAZKA_ANALYTICS_TOKEN: 'a'.repeat(64),
        SVYAZKA_PROFILE_TOKEN: 'b'.repeat(64),
      });
      state = new MarketplaceStateService(db as PrismaService, config);
      max = {
        getChatSnapshot: jest.fn().mockResolvedValue({
          chatId: entityId,
          entityType: kind.toLowerCase(),
          title: 'Synthetic migration platform',
          description: '',
          avatarUrl: null,
          link: null,
          participantsCount: 10,
          isPublic: true,
        }),
        getCurrentChatMemberAccess: jest
          .fn()
          .mockResolvedValue({ userId: botId, isAdmin: true, isOwner: false, isBot: true }),
        getChatMemberAccess: jest
          .fn()
          .mockResolvedValue({ userId: actor, isAdmin: true, isOwner: false, isBot: false }),
      };
      const governor: Pick<jest.Mocked<BackgroundRuntimeGovernorService>, 'decide'> = {
        decide: jest.fn().mockResolvedValue({ action: 'run', retryAfterMs: 0, reason: 'healthy' }),
      };
      access = new MarketplaceAccessService(
        db as PrismaService,
        {
          assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
          resolveManagedEntityReadBotId: jest.fn().mockResolvedValue(botId),
        } as unknown as ManagedEntitiesService,
        max as unknown as MaxClientService,
        state,
        undefined,
        {
          assertAttested: jest.fn().mockResolvedValue(undefined),
        } as unknown as PublisherIdentityAttestationService,
        config,
        governor,
      );
      service = new MarketplaceButtonPolicyService(db as PrismaService, config, state, access);
      jest.spyOn(service, 'readEntry').mockImplementation(async () => entry);
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      await db?.$disconnect();
      await sql.query('ROLLBACK');
      await sql.query(`DROP SCHEMA "${schema}" CASCADE`);
      await sql.end();
      if (previousRole === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = previousRole;
      if (previousService === undefined) delete process.env.APP_SERVICE_NAME;
      else process.env.APP_SERVICE_NAME = previousService;
    });
    const preserved = async () => ({
      binding: (
        await sql.query(
          `SELECT statistics_consent,statistics_v2_consent_only,statistics_revoked_at,append_revision,profile_snapshot,history_signature,history_complete FROM marketplace_bindings WHERE id=$1`,
          [bindingId],
        )
      ).rows,
      generations: (await sql.query('SELECT * FROM marketplace_statistics_generations')).rows,
      samples: (await sql.query('SELECT * FROM marketplace_post_samples')).rows,
      receipts: (await sql.query('SELECT * FROM marketplace_policy_requests')).rows,
    });
    const publication = () =>
      state.resolvePublicationButton({
        chatId: input.entityId,
        botId,
        purpose: 'PUBLICATION',
      });

    it.each(['REVOKED', 'USER_DENIED', 'MEMBER'] as const)(
      'does not import the old opt-in after pre-migration %s and a real healthy reattestation',
      async (loss) => {
        if (loss === 'REVOKED') {
          // This old deny path deliberately leaves append_enabled true before the new trigger.
          await access.deny(input, new Date(Date.now() - 30_000));
        } else {
          await db.managedEntityAccessEdge.create({
            data: {
              chatId: input.entityId,
              userId: actor,
              botId,
              entityType: input.kind,
              state: loss === 'USER_DENIED' ? 'USER_DENIED' : 'GRANTED',
              userRole: loss === 'MEMBER' ? 'MEMBER' : 'ADMIN',
              botRole: 'ADMIN',
              checkedAt: new Date(Date.now() - 30_000),
            },
          });
        }
        expect(
          (await sql.query('SELECT append_enabled FROM marketplace_bindings')).rows[0]
            .append_enabled,
        ).toBe(true);
        const before = await preserved();
        await sql.query(migration);
        if (loss !== 'REVOKED')
          await db.managedEntityAccessEdge.update({
            where: { chatId_userId_botId: { chatId: input.entityId, userId: actor, botId } },
            data: { state: 'GRANTED', userRole: 'ADMIN', checkedAt: new Date(Date.now() - 1_000) },
          });
        const policy = await service.get(input);
        expect(max.getChatMemberAccess).toHaveBeenCalled();
        expect((await state.read(bindingId))!.state).toBe('ACTIVE');
        await service.refresh(profile, () => false);
        expect(policy.contexts.every((context) => !context.enabled)).toBe(true);
        expect(await publication()).toBeNull();
        expect(await state.read(bindingId)).toMatchObject({
          append_enabled: false,
          last_button_access_loss_at: expect.any(Date),
          public_verified_until: null,
        });
        expect(await preserved()).toEqual(before);
        const context = profile === 'publisher' ? 'PUBLICATIONS' : 'GREETINGS';
        await service.mutate(input, {
          context,
          enabled: true,
          expectedRevision: policy.revision,
          requestId: randomUUID(),
        });
        expect(
          await state.resolvePublicationButton({
            chatId: input.entityId,
            botId,
            purpose: profile === 'publisher' ? 'PUBLICATION' : 'GREETING',
          }),
        ).not.toBeNull();
      },
    );

    it('preserves an uninterrupted legacy opt-in only for publications', async () => {
      const before = await preserved();
      await sql.query(migration);
      const policy = await service.get(input);
      expect(
        policy.contexts.filter((context) => context.enabled).map((context) => context.context),
      ).toEqual(['PUBLICATIONS']);
      await service.refresh(profile, () => false);
      expect(await publication()).not.toBeNull();
      expect((await state.read(bindingId))!.last_button_access_loss_at).toBeNull();
      expect(await preserved()).toEqual(before);
      for (const purpose of ['GREETING', 'MODERATION_NOTICE', 'CHANNEL_POST'] as const)
        expect(
          await state.resolvePublicationButton({ chatId: input.entityId, botId, purpose }),
        ).toBeNull();
    });

    it('refuses a busy source table without a partial DDL or backfill, then succeeds after release', async () => {
      const other = new Client({ connectionString: databaseUrl, statement_timeout: 10_000 });
      await other.connect();
      try {
        await other.query('BEGIN');
        await other.query(
          `LOCK TABLE "${schema}".managed_entity_access_edges IN ROW EXCLUSIVE MODE`,
        );
        await expect(sql.query(migration)).rejects.toMatchObject({ code: '55P03' });
        await sql.query('ROLLBACK');
        expect(
          (
            await sql.query(
              `SELECT count(*)::int count FROM information_schema.columns WHERE table_schema=$1 AND table_name='marketplace_bindings' AND column_name='last_button_access_loss_at'`,
              [schema],
            )
          ).rows,
        ).toEqual([{ count: 0 }]);
        expect(
          (
            await sql.query(
              `SELECT count(*)::int count FROM information_schema.tables WHERE table_schema=$1 AND table_name='marketplace_button_policies'`,
              [schema],
            )
          ).rows,
        ).toEqual([{ count: 0 }]);
        await other.query('COMMIT');
        await sql.query(migration);
        expect(
          (await service.get(input)).contexts.some(
            (context) => context.context === 'PUBLICATIONS' && context.enabled,
          ),
        ).toBe(true);
      } finally {
        await other.query('ROLLBACK');
        await other.end();
      }
    });
  },
);
