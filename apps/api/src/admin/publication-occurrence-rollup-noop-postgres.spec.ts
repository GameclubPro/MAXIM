import { createHash, randomUUID } from 'node:crypto';
import { MAX_ACTION_NO_EXECUTABLE_ROUTE_ERROR_CODE } from '../max/max-action-dispatch-error';
import {
  Prisma,
  PrismaClient,
  createPrismaAdapter,
  type ManagedBroadcastStatus,
  type PublicationOccurrenceStatus,
} from '../prisma/prisma-client';
import {
  buildPublicationOccurrenceRollupNoopQuery,
  isUnchangedPublicationOccurrenceRollup,
  PublicationOccurrenceRollupNoopReader,
  type PublicationOccurrenceRollupNoopSnapshot,
} from './publication-occurrence-rollup-noop';
import { findFullPublicationRouteOutageTarget } from './publication-access-loss-recovery';
import { resolvePublicationOccurrenceRollupStatus } from './publication-delivery-verification-state';
import { rollupPublicationOccurrence } from './publication-occurrence-rollup';
import { PublicationOccurrenceRollupScanner } from './publication-occurrence-rollup-scanner';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;
const decisionAt = new Date('2026-10-18T12:00:00.000Z');
const designated = { CHAT: '-78271094414679', CHANNEL: '-78271171091799' } as const;
type Mode = 'test' | '5' | '25' | '100';
type QueryReader = Pick<Prisma.TransactionClient, '$queryRaw'>;
type Root = {
  publicationId: string;
  scheduleId: string;
  revisionId: string;
  botId: string | null;
  profile: 'PUBLIK_V1' | 'LEGACY_ROUTED';
};
type Occurrence = Root & { occurrenceId: string };
type Envelope = Occurrence & { broadcastId: string; envelopeRevisionId: string };
type DeliveryOptions = Partial<
  Pick<
    Prisma.ManagedBroadcastDeliveryCreateManyInput,
    | 'targetChatId'
    | 'occurrenceIndex'
    | 'status'
    | 'contentRevisionId'
    | 'nextAttemptAt'
    | 'lastErrorCode'
    | 'lastError'
    | 'remoteMessageVerifiedAt'
    | 'remoteMessageVerificationNextAt'
    | 'remoteMessageVerificationAttemptCount'
    | 'remoteMessageVerificationAbsentCount'
    | 'remoteMessageVerificationPresentCount'
    | 'remoteMessageVerificationAttemptedAt'
    | 'remoteMessageVerificationSource'
  >
>;
type PlanNode = {
  Plans?: PlanNode[];
  'Node Type': string;
  'Subplan Name'?: string;
  'Parent Relationship'?: string;
  'CTE Name'?: string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Scan Direction'?: string;
  'Recheck Cond'?: string;
  Filter?: string;
  Alias?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  'Heap Fetches'?: number;
  'Exact Heap Blocks'?: number;
  'Lossy Heap Blocks'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
};
type Explained = Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode; 'Execution Time': number }> }>;

jest.setTimeout(30_000);

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function planNodes(value: Explained): PlanNode[] {
  expect(value).toHaveLength(1);
  expect(value[0]!['QUERY PLAN']).toHaveLength(1);
  const nodes: PlanNode[] = [];
  const visit = (node: PlanNode, depth: number): void => {
    // FLAG: A truncated plan is not evidence of bounded work. Refuse it explicitly.
    expect(depth).toBeLessThanOrEqual(32);
    expect(nodes.length).toBeLessThan(256);
    expect(typeof node['Node Type']).toBe('string');
    for (const field of ['Actual Rows', 'Actual Loops'] as const) {
      expect(Number.isFinite(node[field])).toBe(true);
      expect(node[field]).toBeGreaterThanOrEqual(0);
    }
    nodes.push(node);
    node.Plans?.forEach((child) => visit(child, depth + 1));
  };
  visit(value[0]!['QUERY PLAN'][0]!.Plan, 0);
  return nodes;
}

const examined = (node: PlanNode) =>
  node['Actual Loops'] *
  (node['Actual Rows'] +
    (node['Rows Removed by Filter'] ?? 0) +
    (node['Rows Removed by Index Recheck'] ?? 0));

function expectBoundedMicroScan(node: PlanNode): void {
  // FLAG: A one-page heap may legitimately beat an index. This exception proves
  // physical work, never audience completeness, and cannot admit delivery scans.
  expect(node['Node Type']).toBe('Seq Scan');
  expect(['publication_occurrences', 'managed_broadcasts', 'publications']).toContain(
    node['Relation Name'],
  );
  expect(node['Actual Loops']).toBe(1);
  for (const field of ['Actual Rows', 'Shared Hit Blocks', 'Shared Read Blocks'] as const) {
    expect(Number.isFinite(node[field])).toBe(true);
    expect(node[field]).toBeGreaterThanOrEqual(0);
  }
  for (const field of ['Rows Removed by Filter', 'Rows Removed by Index Recheck'] as const) {
    expect(Number.isFinite(node[field] ?? 0)).toBe(true);
    expect(node[field] ?? 0).toBeGreaterThanOrEqual(0);
  }
  expect(examined(node)).toBeLessThanOrEqual(2);
  expect(node['Rows Removed by Index Recheck'] ?? 0).toBe(0);
  expect(node['Shared Hit Blocks']! + node['Shared Read Blocks']!).toBeLessThanOrEqual(4);
}

function expectOccurrenceSeek(nodes: PlanNode[], requirePrimaryKey = false): void {
  const scans = nodes.filter(
    (node) => node['Relation Name'] === 'publication_occurrences' && node['Actual Loops'] > 0,
  );
  expect(scans).toHaveLength(2);
  expect(scans.reduce((total, scan) => total + examined(scan), 0)).toBeLessThanOrEqual(
    requirePrimaryKey ? 2 : 3,
  );
  for (const scan of scans) {
    if (scan['Node Type'] === 'Seq Scan' && !requirePrimaryKey) {
      expectBoundedMicroScan(scan);
      continue;
    }
    expect(scan['Node Type']).toMatch(/^Index (Only )?Scan$/u);
    expect(scan['Index Name']).toBe('publication_occurrences_pkey');
    expect(scan.Filter).toBeUndefined();
    expect(examined(scan)).toBe(1);
    expect(scan['Actual Loops']).toBe(1);
  }
  const seek = scans.find((scan) => scan['Index Cond']?.startsWith("(id >= '"));
  expect(seek).toBeDefined();
  expect(seek!['Node Type']).toBe('Index Only Scan');
  expect(seek!['Index Cond']).toMatch(/^\(id >= .+\)$/u);
  const metadata = scans.find((scan) => scan !== seek)!;
  if (metadata['Node Type'] !== 'Seq Scan') {
    expect(metadata['Node Type']).toBe('Index Scan');
    expect(metadata['Scan Direction']).toBe('Forward');
    expect(metadata['Index Cond']).toBe('(id >= candidate.id)');
  }
  for (const scan of [seek!, metadata].filter((scan) => scan['Node Type'] !== 'Seq Scan')) {
    const parents = nodes.filter((node) => node.Plans?.includes(scan));
    expect(parents).toHaveLength(1);
    const parent = parents[0]!;
    expect(parent['Node Type']).toBe('Limit');
    expect(parent.Plans).toEqual([scan]);
    expect(parent['Actual Rows']).toBe(1);
    expect(parent['Actual Loops']).toBe(1);
  }
}

function expectBoundedEnvelopeBitmap(node: PlanNode): void {
  expect(node['Node Type']).toBe('Bitmap Heap Scan');
  expect(node['Relation Name']).toBe('managed_broadcasts');
  expect(node.Filter).toBeUndefined();
  expect(node['Rows Removed by Filter'] ?? 0).toBe(0);
  expect(node['Rows Removed by Index Recheck'] ?? 0).toBe(0);
  expect(node['Lossy Heap Blocks']).toBe(0);
  expect(node['Exact Heap Blocks']).toBeLessThanOrEqual(2);
  expect(examined(node)).toBeLessThanOrEqual(2);
  expect(node['Actual Loops']).toBeLessThanOrEqual(2);
  const initializers =
    node.Plans?.filter((child) => child['Parent Relationship'] === 'InitPlan') ?? [];
  expect(initializers.length).toBeLessThanOrEqual(1);
  for (const initializer of initializers) {
    expect(initializer['Node Type']).toBe('CTE Scan');
    expect(initializer['CTE Name']).toBe('rollup_scope');
    expect(examined(initializer)).toBeLessThanOrEqual(1);
    expect(initializer['Actual Loops']).toBeLessThanOrEqual(1);
    expect(initializer.Plans ?? []).toHaveLength(0);
  }
  const paths = node.Plans?.filter((child) => child['Parent Relationship'] !== 'InitPlan') ?? [];
  expect(paths).toHaveLength(1);
  const path = paths[0]!;
  expect(path['Node Type']).toBe('Bitmap Index Scan');
  expect(path['Index Name']).toBe('managed_broadcasts_pub_occurrence_entity_key');
  expect(path['Index Cond']).toMatch(
    /^\(publication_occurrence_id = (?:\$\d+|(?:occurrence|scope)\.id)\)$/u,
  );
  expect(node['Recheck Cond']).toBe(path['Index Cond']);
  expect(path.Filter).toBeUndefined();
  expect(path.Plans ?? []).toHaveLength(0);
  expect(examined(path)).toBeLessThanOrEqual(2);
  expect(path['Actual Loops']).toBeLessThanOrEqual(2);
  for (const part of [node, path]) {
    expect(part['Shared Hit Blocks'] ?? 0).toBeLessThan(256);
    expect(part['Shared Read Blocks'] ?? 0).toBeLessThan(256);
  }
}

function expectBoundedCatalogScan(node: PlanNode): void {
  expect(node['Node Type']).toBe('Index Scan');
  expect(node['Relation Name']).toBe('pg_class');
  expect(node['Index Name']).toBe('pg_class_oid_index');
  expect(node['Index Cond']).toMatch(/^\(oid = '\d+'::oid\)$/u);
  expect(node.Filter).toBeUndefined();
  expect(node['Rows Removed by Index Recheck'] ?? 0).toBe(0);
  expect(node['Actual Rows']).toBe(1);
  expect(node['Actual Loops']).toBe(1);
  for (const field of ['Shared Hit Blocks', 'Shared Read Blocks'] as const) {
    expect(Number.isFinite(node[field])).toBe(true);
    expect(node[field]).toBeGreaterThanOrEqual(0);
  }
  expect(node['Shared Hit Blocks']! + node['Shared Read Blocks']!).toBeLessThanOrEqual(8);
}

function expectRecipientScanEvidence(node: PlanNode, rows: number, loops: number): void {
  expect(node['Relation Name']).toBe('managed_broadcast_deliveries');
  expect(node['Index Name']).toBe('managed_broadcast_deliveries_broadcast_occurrence_target_key');
  expect(node.Filter).toBeUndefined();
  expect(node['Rows Removed by Filter'] ?? 0).toBe(0);
  expect(node['Rows Removed by Index Recheck'] ?? 0).toBe(0);
  for (const field of [
    'Actual Rows',
    'Actual Loops',
    'Shared Hit Blocks',
    'Shared Read Blocks',
  ] as const) {
    expect(Number.isFinite(node[field])).toBe(true);
    expect(node[field]).toBeGreaterThanOrEqual(0);
  }
  expect(node['Actual Rows']).toBeLessThanOrEqual(rows);
  expect(node['Actual Loops']).toBeGreaterThan(0);
  expect(node['Actual Loops']).toBeLessThanOrEqual(loops);
  expect(examined(node)).toBeLessThanOrEqual(6);
  expect(node['Shared Hit Blocks']! + node['Shared Read Blocks']!).toBeLessThan(256);
  if (node['Node Type'] === 'Index Only Scan' || node['Heap Fetches'] !== undefined) {
    expect(Number.isFinite(node['Heap Fetches'])).toBe(true);
    expect(node['Heap Fetches']).toBeGreaterThanOrEqual(0);
    expect(node['Heap Fetches']).toBeLessThanOrEqual(6);
  }
}

function expectRecipientKeySeek(node: PlanNode, nodes: PlanNode[]): void {
  // FLAG: Cap the leading key-only seek before exact envelope filtering. An
  // ordered output without a direct LIMIT can still read retained history.
  expectRecipientScanEvidence(node, 3, 2);
  expect(node['Node Type']).toBe('Index Only Scan');
  expect(node.Alias).toBe('recipient_key');
  const envelopeAliases = nodes
    .filter(
      (candidate) =>
        candidate['Relation Name'] === 'managed_broadcasts' &&
        candidate['Index Name'] === 'managed_broadcasts_pkey' &&
        candidate['Index Cond'] === '(id = envelope_id.id)',
    )
    .map((candidate) => candidate.Alias)
    .filter((alias): alias is string => typeof alias === 'string');
  expect(['saved', ...envelopeAliases].map((alias) => `(broadcast_id >= ${alias}.id)`)).toContain(
    node['Index Cond'],
  );
  const caps = nodes.filter((candidate) => candidate.Plans?.includes(node));
  expect(caps).toHaveLength(1);
  const cap = caps[0]!;
  expect(cap['Node Type']).toBe('Limit');
  expect(cap.Plans).toEqual([node]);
  for (const field of ['Actual Rows', 'Actual Loops'] as const) {
    expect(Number.isFinite(cap[field])).toBe(true);
    expect(cap[field]).toBeGreaterThanOrEqual(0);
    expect(cap[field]).toBe(node[field]);
  }
  expect(cap['Actual Rows']).toBeLessThanOrEqual(3);
  expect(cap['Actual Loops']).toBeLessThanOrEqual(2);
}

function expectRecipientMetadataSeek(node: PlanNode, nodes: PlanNode[]): void {
  // FLAG: Seek one full composite key before exact identity checks. Scalar
  // equalities can pick a non-leading index and scan retained recipient history.
  expectRecipientScanEvidence(node, 1, 6);
  expect(node['Node Type']).toBe('Index Scan');
  expect(node.Alias).toBe('recipient_saved');
  expect(node['Scan Direction']).toBe('Forward');
  expect(node['Index Cond']).toMatch(
    /^\(ROW\(broadcast_id, occurrence_index, target_chat_id\) >= ROW\((candidate(?:_\d+)?)\.broadcast_id, \1\.occurrence_index, \1\.target_chat_id\)\)$/u,
  );
  const caps = nodes.filter((candidate) => candidate.Plans?.includes(node));
  expect(caps).toHaveLength(1);
  const cap = caps[0]!;
  expect(cap['Node Type']).toBe('Limit');
  expect(cap.Plans).toEqual([node]);
  for (const field of ['Actual Rows', 'Actual Loops'] as const) {
    expect(Number.isFinite(cap[field])).toBe(true);
    expect(cap[field]).toBeGreaterThanOrEqual(0);
    expect(cap[field]).toBe(node[field]);
  }
  expect(cap['Actual Rows']).toBeLessThanOrEqual(1);
  expect(cap['Actual Loops']).toBeLessThanOrEqual(6);
}

describe('Bounded tiny occurrence/envelope/publication heap validation', () => {
  function tinyScan(): PlanNode {
    return {
      'Node Type': 'Seq Scan',
      'Relation Name': 'publication_occurrences',
      'Actual Rows': 1,
      'Actual Loops': 1,
      'Rows Removed by Filter': 0,
      'Shared Hit Blocks': 1,
      'Shared Read Blocks': 0,
    };
  }

  it.each(['publication_occurrences', 'managed_broadcasts', 'publications'])(
    'accepts at most two examined rows and four total buffers for %s',
    (relation) => {
      expectBoundedMicroScan({
        ...tinyScan(),
        'Relation Name': relation,
        'Rows Removed by Filter': 1,
        'Shared Hit Blocks': 2,
        'Shared Read Blocks': 2,
      });
    },
  );

  it.each<Partial<PlanNode>>([
    { 'Actual Rows': 3 },
    { 'Actual Rows': NaN },
    { 'Rows Removed by Filter': 2 },
    { 'Rows Removed by Filter': -1 },
    { 'Rows Removed by Filter': NaN },
    { 'Actual Loops': 0 },
    { 'Actual Loops': 2 },
    { 'Shared Hit Blocks': 3, 'Shared Read Blocks': 2 },
    { 'Shared Hit Blocks': undefined },
    { 'Shared Read Blocks': NaN },
    { 'Shared Read Blocks': -1 },
    { 'Relation Name': 'managed_broadcast_deliveries' },
    { 'Relation Name': 'publication_targets' },
  ])('refuses unbounded or unsupported physical evidence %j', (mutation) => {
    expect(() => expectBoundedMicroScan({ ...tinyScan(), ...mutation })).toThrow();
  });

  it('refuses even a tiny heap when the retained-history case requires a primary-key seek', () => {
    const scan = tinyScan();
    const seek: PlanNode = {
      'Node Type': 'Index Only Scan',
      'Relation Name': 'publication_occurrences',
      'Index Name': 'publication_occurrences_pkey',
      'Index Cond': "(id >= 'owned'::text)",
      'Actual Rows': 1,
      'Actual Loops': 1,
    };
    const limit: PlanNode = {
      'Node Type': 'Limit',
      'Actual Rows': 1,
      'Actual Loops': 1,
      Plans: [seek],
    };
    expectOccurrenceSeek([scan, seek, limit]);
    expect(() => expectOccurrenceSeek([scan, seek, limit], true)).toThrow();
  });

  it('refuses a non-leading occurrence index even when its output and buffers look small', () => {
    const scan: PlanNode = {
      'Node Type': 'Index Only Scan',
      'Relation Name': 'publication_occurrences',
      'Index Name': 'publication_occurrences_pkey',
      'Index Cond': "(id >= 'owned'::text)",
      'Actual Rows': 1,
      'Actual Loops': 1,
      'Shared Hit Blocks': 1,
      'Shared Read Blocks': 0,
    };
    const limit: PlanNode = {
      'Node Type': 'Limit',
      'Actual Rows': 1,
      'Actual Loops': 1,
      Plans: [scan],
    };
    const metadata: PlanNode = {
      ...scan,
      'Node Type': 'Index Scan',
      'Scan Direction': 'Forward',
      'Index Cond': '(id >= candidate.id)',
    };
    const metadataLimit: PlanNode = { ...limit, Plans: [metadata] };
    expectOccurrenceSeek([scan, metadata, limit, metadataLimit], true);
    scan['Index Name'] = 'publication_occurrences_dispatch_status_created_id_idx';
    expect(() => expectOccurrenceSeek([scan, metadata, limit, metadataLimit], true)).toThrow();
  });

  it.each<Partial<PlanNode>>([
    { 'Index Cond': '(id = candidate.id)' },
    { 'Index Name': 'publication_occurrences_dispatch_status_created_id_idx' },
    { 'Node Type': 'Bitmap Heap Scan' },
    { 'Scan Direction': 'Backward' },
    { 'Actual Rows': 2 },
    { 'Actual Loops': 2 },
    { Filter: '(id = candidate.id)' },
  ])('refuses an uncapped or non-leading metadata path %j', (mutation) => {
    const seek: PlanNode = {
      'Node Type': 'Index Only Scan',
      'Relation Name': 'publication_occurrences',
      'Index Name': 'publication_occurrences_pkey',
      'Index Cond': "(id >= 'owned'::text)",
      'Actual Rows': 1,
      'Actual Loops': 1,
    };
    const metadata: PlanNode = {
      ...seek,
      'Node Type': 'Index Scan',
      'Scan Direction': 'Forward',
      'Index Cond': '(id >= candidate.id)',
    };
    const limit = (node: PlanNode): PlanNode => ({
      'Node Type': 'Limit',
      'Actual Rows': 1,
      'Actual Loops': 1,
      Plans: [node],
    });
    const nodes = [seek, metadata, limit(seek), limit(metadata)];
    expectOccurrenceSeek(nodes, true);
    expect(() => expectOccurrenceSeek(nodes.slice(0, 3), true)).toThrow();
    Object.assign(metadata, mutation);
    expect(() => expectOccurrenceSeek(nodes, true)).toThrow();
  });
});

describe('Bounded test-enrollment recipient plan validation', () => {
  function keySeek(): PlanNode {
    return {
      'Node Type': 'Index Only Scan',
      'Relation Name': 'managed_broadcast_deliveries',
      Alias: 'recipient_key',
      'Index Name': 'managed_broadcast_deliveries_broadcast_occurrence_target_key',
      'Index Cond': '(broadcast_id >= saved.id)',
      'Actual Rows': 3,
      'Actual Loops': 2,
      'Heap Fetches': 6,
      'Shared Hit Blocks': 8,
      'Shared Read Blocks': 0,
    };
  }

  function cap(node: PlanNode): PlanNode {
    return {
      'Node Type': 'Limit',
      'Actual Rows': node['Actual Rows'],
      'Actual Loops': node['Actual Loops'],
      Plans: [node],
    };
  }

  function metadataSeek(): PlanNode {
    return {
      ...keySeek(),
      'Node Type': 'Index Scan',
      'Scan Direction': 'Forward',
      Alias: 'recipient_saved',
      'Index Cond':
        '(ROW(broadcast_id, occurrence_index, target_chat_id) >= ROW(candidate_1.broadcast_id, candidate_1.occurrence_index, candidate_1.target_chat_id))',
      'Actual Rows': 1,
      'Actual Loops': 6,
      'Heap Fetches': undefined,
    };
  }

  it('accepts the capped leading-key page and composite metadata seek at their physical budgets', () => {
    const key = keySeek();
    expectRecipientKeySeek(key, [key, cap(key)]);
    const metadata = metadataSeek();
    expectRecipientMetadataSeek(metadata, [metadata, cap(metadata)]);
  });

  it.each<Partial<PlanNode>>([
    { 'Node Type': 'Index Scan' },
    { 'Node Type': 'Bitmap Heap Scan' },
    { 'Node Type': 'Seq Scan' },
    { 'Index Name': 'managed_broadcast_deliveries_broadcast_occurrence_status_idx' },
    { 'Index Cond': '(occurrence_index >= saved.id)' },
    { 'Index Cond': '(broadcast_id = saved.id)' },
    { 'Index Cond': '(broadcast_id >= foreign.id)' },
    { 'Index Cond': '((broadcast_id >= saved.id) AND (occurrence_index = 1))' },
    { Filter: '(status = PENDING)' },
    { 'Rows Removed by Filter': 1 },
    { 'Rows Removed by Index Recheck': 1 },
    { 'Actual Rows': 4 },
    { 'Actual Rows': NaN },
    { 'Actual Loops': 3 },
    { 'Actual Loops': 0 },
    { 'Heap Fetches': 7 },
    { 'Heap Fetches': undefined },
    { 'Heap Fetches': NaN },
    { 'Shared Hit Blocks': undefined },
    { 'Shared Hit Blocks': -1 },
    { 'Shared Hit Blocks': 255, 'Shared Read Blocks': 1 },
    { 'Shared Read Blocks': NaN },
  ])('refuses a recipient key seek with unsupported evidence %j', (mutation) => {
    const key = { ...keySeek(), ...mutation };
    expect(() => expectRecipientKeySeek(key, [key, cap(key)])).toThrow();
  });

  it.each(['missing cap', 'sort before cap', 'multiple children', 'inconsistent count'] as const)(
    'refuses a recipient key page with %s even if the scan currently returns only three rows',
    (variant) => {
      const key = keySeek();
      const limit = cap(key);
      let nodes = [key, limit];
      if (variant === 'missing cap') nodes = [key];
      if (variant === 'sort before cap') {
        const sort = { ...limit, 'Node Type': 'Sort' };
        limit.Plans = [sort];
        nodes = [key, sort, limit];
      }
      if (variant === 'multiple children') limit.Plans = [key, { ...key }];
      if (variant === 'inconsistent count') limit['Actual Rows'] = 2;
      expect(() => expectRecipientKeySeek(key, nodes)).toThrow();
    },
  );

  it.each<Partial<PlanNode>>([
    { 'Node Type': 'Index Only Scan' },
    { 'Node Type': 'Bitmap Heap Scan' },
    { 'Node Type': 'Seq Scan' },
    { 'Index Name': 'managed_broadcast_deliveries_broadcast_occurrence_status_idx' },
    { 'Index Name': 'managed_broadcast_deliveries_target_remote_idx' },
    { 'Scan Direction': 'Backward' },
    { 'Index Cond': '(broadcast_id = candidate_1.broadcast_id)' },
    {
      'Index Cond':
        '((broadcast_id = candidate_1.broadcast_id) AND (occurrence_index = candidate_1.occurrence_index) AND (target_chat_id = candidate_1.target_chat_id))',
    },
    {
      'Index Cond':
        '(ROW(broadcast_id, occurrence_index) >= ROW(candidate_1.broadcast_id, candidate_1.occurrence_index))',
    },
    {
      'Index Cond':
        '(ROW(broadcast_id, occurrence_index, target_chat_id) >= ROW(candidate_1.broadcast_id, candidate_1.occurrence_index, candidate_2.target_chat_id))',
    },
    {
      'Index Cond':
        '(ROW(broadcast_id, occurrence_index, target_chat_id) <= ROW(candidate_1.broadcast_id, candidate_1.occurrence_index, candidate_1.target_chat_id))',
    },
    {
      'Index Cond':
        '(ROW(broadcast_id, occurrence_index, target_chat_id) > ROW(candidate_1.broadcast_id, candidate_1.occurrence_index, candidate_1.target_chat_id))',
    },
    {
      'Index Cond':
        '(ROW(target_chat_id, occurrence_index, broadcast_id) >= ROW(candidate_1.target_chat_id, candidate_1.occurrence_index, candidate_1.broadcast_id))',
    },
    {
      'Index Cond':
        '((ROW(broadcast_id, occurrence_index, target_chat_id) >= ROW(candidate_1.broadcast_id, candidate_1.occurrence_index, candidate_1.target_chat_id)) AND (status = PENDING))',
    },
    { Filter: '(content_revision_id = occurrence.content_revision_id)' },
    { 'Actual Rows': 2 },
    { 'Actual Loops': 7 },
    { 'Shared Read Blocks': -1 },
  ])('refuses recipient metadata without the bounded full-key lower seek %j', (mutation) => {
    const metadata = { ...metadataSeek(), ...mutation };
    expect(() => expectRecipientMetadataSeek(metadata, [metadata, cap(metadata)])).toThrow();
  });

  it.each(['missing cap', 'sort before cap', 'multiple children', 'inconsistent count'] as const)(
    'refuses a metadata seek with %s even if the scan currently returns only one row',
    (variant) => {
      const metadata = metadataSeek();
      const limit = cap(metadata);
      let nodes = [metadata, limit];
      if (variant === 'missing cap') nodes = [metadata];
      if (variant === 'sort before cap') {
        const sort = { ...limit, 'Node Type': 'Sort' };
        limit.Plans = [sort];
        nodes = [metadata, sort, limit];
      }
      if (variant === 'multiple children') limit.Plans = [metadata, { ...metadata }];
      if (variant === 'inconsistent count') limit['Actual Rows'] = 0;
      expect(() => expectRecipientMetadataSeek(metadata, nodes)).toThrow();
    },
  );
});

describe('Exact envelope bitmap plan validation', () => {
  function validBitmap(): PlanNode {
    return {
      'Node Type': 'Bitmap Heap Scan',
      'Relation Name': 'managed_broadcasts',
      'Actual Rows': 1,
      'Actual Loops': 1,
      'Recheck Cond': '(publication_occurrence_id = $3)',
      'Exact Heap Blocks': 1,
      'Lossy Heap Blocks': 0,
      'Shared Hit Blocks': 4,
      Plans: [
        {
          'Node Type': 'Bitmap Index Scan',
          'Index Name': 'managed_broadcasts_pub_occurrence_entity_key',
          'Index Cond': '(publication_occurrence_id = $3)',
          'Actual Rows': 1,
          'Actual Loops': 1,
          'Shared Hit Blocks': 3,
        },
      ],
    };
  }

  it('accepts one lossless exact unique-key bitmap without changing its work bound', () => {
    expectBoundedEnvelopeBitmap(validBitmap());
  });

  it.each(['global status', 'status intersection', 'residual filter', 'lossy heap'] as const)(
    'refuses a %s plan even when it returns only one envelope',
    (variant) => {
      const plan = validBitmap();
      const path = plan.Plans![0]!;
      if (variant === 'global status') {
        path['Index Name'] = 'managed_broadcasts_status_next_send_idx';
        path['Index Cond'] = '(status = ACTIVE)';
      } else if (variant === 'status intersection') {
        plan.Plans = [{ ...path, 'Node Type': 'BitmapAnd', Plans: [path] }];
      } else if (variant === 'residual filter') {
        plan.Filter = '(status = ACTIVE)';
      } else {
        plan['Lossy Heap Blocks'] = 1;
      }
      expect(() => expectBoundedEnvelopeBitmap(plan)).toThrow();
    },
  );
});

postgres('Publication occurrence rollup no-op proofs on PostgreSQL', () => {
  let db: PrismaClient;
  let sourceChatId: string;
  let root: Root;
  let publicationIds: string[];
  let ownedChatIds: string[];
  let sequence: number;
  const queries: Prisma.QueryEvent[] = [];
  const dialogBotId = `rollup-noop-dialog-${randomUUID()}`;

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    const client = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 5, statement_timeout: 10_000 }),
      log: [{ emit: 'event', level: 'query' }],
    });
    client.$on('query', (event) => queries.push(event));
    db = client;
    await db.$connect();
    expect(await db.$queryRawUnsafe<Array<{ TimeZone: string }>>('SHOW TimeZone')).toEqual([
      { TimeZone: 'UTC' },
    ]);
  });

  beforeEach(async () => {
    publicationIds = [];
    ownedChatIds = [];
    sequence = 0;
    sourceChatId = `-${BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`)}`;
    await db.chat.create({ data: { id: sourceChatId, title: 'Synthetic rollup no-op fixture' } });
    ownedChatIds.push(sourceChatId);
    root = await publication();
    queries.length = 0;
  });

  afterEach(async () => cleanupOwnedFixture(publicationIds, ownedChatIds), 60_000);
  afterAll(async () => db?.$disconnect());

  async function cleanupOwnedFixture(ownedPublications: string[], ownedChats: string[]) {
    // FLAG: Keep the 10 s SQL timeout and 45 s aggregate budget. Attest small
    // envelope pages once, then use direct delivery index membership; do not
    // repeat a ten-thousand-root ownership join for every delivery page.
    const deadline = Date.now() + 45_000;
    const batchSize = 500;
    type Phase = 'deliveries' | 'envelopes' | 'occurrences' | 'publications' | 'chats';
    const newEvidence = () => ({ selects: 0, deletes: 0, removed: 0, elapsedMs: 0 });
    const evidence: Record<Phase, ReturnType<typeof newEvidence>> = {
      deliveries: newEvidence(),
      envelopes: newEvidence(),
      occurrences: newEvidence(),
      publications: newEvidence(),
      chats: newEvidence(),
    };
    const assertCleanupTime = (phase: Phase) => {
      if (Date.now() >= deadline)
        throw new Error(`Owned rollup fixture cleanup exceeded 45 s during ${phase}`);
    };
    async function selectPage(phase: Phase, select: () => Promise<Array<{ id: string }>>) {
      assertCleanupTime(phase);
      const startedAt = Date.now();
      try {
        const rows = await select();
        evidence[phase].selects++;
        assertCleanupTime(phase);
        return rows;
      } finally {
        evidence[phase].elapsedMs += Date.now() - startedAt;
      }
    }
    async function removePage(phase: Phase, remove: () => Promise<Prisma.BatchPayload>) {
      assertCleanupTime(phase);
      const startedAt = Date.now();
      try {
        const result = await remove();
        evidence[phase].deletes++;
        evidence[phase].removed += result.count;
        assertCleanupTime(phase);
        return result.count;
      } finally {
        evidence[phase].elapsedMs += Date.now() - startedAt;
      }
    }
    async function drain(
      phase: Phase,
      select: () => Promise<Array<{ id: string }>>,
      remove: (ids: string[]) => Promise<Prisma.BatchPayload>,
    ) {
      for (;;) {
        const rows = await selectPage(phase, select);
        if (rows.length === 0) return;
        const removed = await removePage(phase, () => remove(rows.map((row) => row.id)));
        expect(removed).toBe(rows.length);
      }
    }
    const page = { select: { id: true }, orderBy: { id: 'asc' }, take: batchSize } as const;
    const rootPages: string[][] = [];
    for (let index = 0; index < ownedPublications.length; index += batchSize)
      rootPages.push(ownedPublications.slice(index, index + batchSize));
    let complete = false;
    try {
      for (const roots of rootPages) {
        const ownership: Prisma.ManagedBroadcastWhereInput = {
          sourceChatId,
          publicationOccurrence: { publicationId: { in: roots } },
        };
        for (;;) {
          const envelopes = await selectPage('envelopes', () =>
            db.managedBroadcast.findMany({ ...page, where: ownership }),
          );
          if (envelopes.length === 0) break;
          const envelopeIds = envelopes.map((row) => row.id);
          // FLAG: The selected envelope IDs are exact owned identities. Native
          // triggers populate delivery attribution; neither omitted insert fields
          // nor nullable schema columns bypass these ownership checks.
          const deliveries = { broadcastId: { in: envelopeIds } };
          await drain(
            'deliveries',
            () =>
              db.managedBroadcastDelivery.findMany({
                select: { id: true },
                where: deliveries,
                orderBy: [
                  { broadcastId: 'asc' },
                  { occurrenceIndex: 'asc' },
                  { targetChatId: 'asc' },
                ],
                take: batchSize,
              }),
            (ids) =>
              db.managedBroadcastDelivery.deleteMany({
                where: { ...deliveries, id: { in: ids } },
              }),
          );
          const removed = await removePage('envelopes', () =>
            db.managedBroadcast.deleteMany({
              where: { ...ownership, id: { in: envelopeIds } },
            }),
          );
          expect(removed).toBe(envelopes.length);
        }
      }
      for (const roots of rootPages) {
        const ownership = { publicationId: { in: roots } };
        await drain(
          'occurrences',
          () => db.publicationOccurrence.findMany({ ...page, where: ownership }),
          (ids) =>
            db.publicationOccurrence.deleteMany({ where: { ...ownership, id: { in: ids } } }),
        );
      }
      for (const roots of rootPages) {
        await drain(
          'publications',
          () => db.publication.findMany({ ...page, where: { id: { in: roots } } }),
          (ids) => db.publication.deleteMany({ where: { id: { in: ids } } }),
        );
      }
      for (let index = 0; index < ownedChats.length; index += batchSize) {
        await removePage('chats', () =>
          db.chat.deleteMany({ where: { id: { in: ownedChats.slice(index, index + batchSize) } } }),
        );
      }
      complete = true;
      return { deliveryCount: evidence.deliveries.removed };
    } finally {
      // FLAG: Aggregate fixture evidence contains no IDs. A failed or overdue
      // operation remains failed; this report must not imply cleanup completed.
      console.info(
        'Publication rollup owned fixture cleanup',
        JSON.stringify({ complete, phases: evidence }),
      );
    }
  }

  async function publication(
    id: string = randomUUID(),
    profile: Root['profile'] = 'PUBLIK_V1',
    botId = `rollup-noop-bot-${randomUUID()}`,
    client: Prisma.TransactionClient = db,
  ): Promise<Root> {
    const value = await client.publication.create({
      data: {
        id,
        actorUserId: sourceChatId,
        requestId: randomUUID(),
        lifecycle: 'ACTIVE',
        audienceMode: 'SNAPSHOT',
        dispatchProfile: profile,
        requiredBotId: profile === 'PUBLIK_V1' ? botId : null,
        contentRevisions: { create: { revision: 1, text: 'Synthetic rollup no-op fixture' } },
        schedule: {
          create: { mode: 'NOW', status: 'ACTIVE', rule: { mode: 'now', timezone: 'UTC' } },
        },
      },
      include: { schedule: true, contentRevisions: true },
    });
    publicationIds.push(value.id);
    const revisionId = value.contentRevisions[0]!.id;
    await client.publication.update({
      where: { id: value.id },
      data: { canonicalContentRevisionId: revisionId },
    });
    return {
      publicationId: value.id,
      scheduleId: value.schedule!.id,
      revisionId,
      botId: value.requiredBotId,
      profile,
    };
  }

  async function retainOwnedParentHistory(
    parent: Root,
    prefix = `synthetic-retained-${randomUUID()}-`,
    client: Prisma.TransactionClient = db,
    count: 1_000 | 10_000 = 10_000,
    firstSlot = 1,
  ): Promise<void> {
    // FLAG: Add only this test's retained parent metadata. Delivery cardinality,
    // physical-plan budgets, native constraints and owned cleanup remain unchanged.
    expect(publicationIds).toContain(parent.publicationId);
    // FLAG: These inserts use normal native constraints/triggers. The extra roots
    // make refreshed planner statistics representative instead of tiny-table scans.
    // FLAG: Bound each setup statement while retaining the complete native FK graph.
    // Append callers use fresh slots to preserve the native publication/revision key.
    for (let first = firstSlot; first < firstSlot + count; first += 1_000) {
      await client.$executeRaw(Prisma.sql`
        INSERT INTO publications (
          id, actor_user_id, request_id, lifecycle, dispatch_profile, required_bot_id, updated_at
        )
        SELECT ${prefix} || n::text, ${sourceChatId}, ${prefix} || n::text,
          'DRAFT'::"PublicationLifecycle", 'PUBLIK_V1'::"PublicationDispatchProfile",
          ${parent.botId}, ${decisionAt}
        FROM generate_series(${first}::integer, ${first + 999}::integer) n
      `);
      publicationIds.push(
        ...Array.from({ length: 1_000 }, (_, index) => `${prefix}${first + index}`),
      );
      await client.$executeRaw(Prisma.sql`
        INSERT INTO publication_occurrences (
          id, publication_id, schedule_id, content_revision_id,
          schedule_revision, scheduled_at, status, updated_at
        )
        SELECT ${prefix} || 'occurrence-' || n::text,
          ${parent.publicationId}, ${parent.scheduleId}, ${parent.revisionId},
          1, ${decisionAt}::timestamp - interval '1 day' - n * interval '1 millisecond',
          'SENT'::"PublicationOccurrenceStatus", ${decisionAt}
        FROM generate_series(${first}::integer, ${first + 999}::integer) n
      `);
      await client.$executeRaw(Prisma.sql`
        INSERT INTO managed_broadcasts (
          id, source_chat_id, actor_user_id, entity_type, target_chat_ids, buttons,
          publication_occurrence_id, publication_content_revision_id, status, updated_at
        )
        SELECT ${prefix} || 'envelope-' || n::text,
          ${sourceChatId}, ${sourceChatId}, 'CHAT'::"ChatEntityType",
          jsonb_build_array(${sourceChatId}::text), '[]'::jsonb,
          ${prefix} || 'occurrence-' || n::text, ${parent.revisionId},
          'COMPLETED'::"ManagedBroadcastStatus", ${decisionAt}
        FROM generate_series(${first}::integer, ${first + 999}::integer) n
      `);
    }
    if (client === db) {
      // FLAG: These positive-plan fixtures explicitly opt into analyzed parents.
      // The caller-owned transaction below separately proves zero/positive stale stats.
      await db.$executeRawUnsafe(
        'ANALYZE publications, publication_occurrences, managed_broadcasts',
      );
    }
  }

  async function occurrence(
    options: {
      id?: string;
      status?: PublicationOccurrenceStatus;
      scheduledAt?: Date;
      publication?: Root;
    } = {},
    client: Prisma.TransactionClient = db,
  ): Promise<Occurrence> {
    const parent = options.publication ?? root;
    const row = await client.publicationOccurrence.create({
      data: {
        ...(options.id ? { id: options.id } : {}),
        publicationId: parent.publicationId,
        scheduleId: parent.scheduleId,
        contentRevisionId: parent.revisionId,
        scheduleRevision: ++sequence,
        scheduledAt: options.scheduledAt ?? new Date(decisionAt.getTime() - 60_000),
        status: options.status ?? 'IN_PROGRESS',
        dispatchProfile: parent.profile,
        requiredBotId: parent.botId,
      },
    });
    if (client === db) {
      // FLAG: Positive shortcut cases require supported statistics. No runtime
      // ANALYZE is added, and the unsupported-stat transaction never takes this path.
      await db.$executeRawUnsafe('ANALYZE publication_occurrences');
    }
    return { ...parent, occurrenceId: row.id };
  }

  async function envelope(
    parent: Occurrence,
    options: {
      id?: string;
      entityType?: 'CHAT' | 'CHANNEL';
      status?: ManagedBroadcastStatus;
      savedTargets?: Prisma.InputJsonValue;
      revisionId?: string;
      applyToAllChats?: boolean;
    } = {},
    client: Prisma.TransactionClient = db,
  ): Promise<Envelope> {
    const envelopeRevisionId = options.revisionId ?? parent.revisionId;
    const row = await client.managedBroadcast.create({
      data: {
        ...(options.id ? { id: options.id } : {}),
        sourceChatId,
        actorUserId: sourceChatId,
        entityType: options.entityType ?? 'CHAT',
        targetChatIds: options.savedTargets ?? [sourceChatId],
        applyToAllChats: options.applyToAllChats ?? false,
        buttons: [],
        publicationOccurrenceId: parent.occurrenceId,
        publicationContentRevisionId: envelopeRevisionId,
        dispatchProfile: parent.profile,
        requiredBotId: parent.botId,
        status: options.status ?? 'ACTIVE',
      },
    });
    return { ...parent, broadcastId: row.id, envelopeRevisionId };
  }

  async function delivery(
    item: Envelope,
    options: DeliveryOptions = {},
    client: Prisma.TransactionClient = db,
  ) {
    const status = options.status ?? 'PENDING';
    const sent = status === 'SENT';
    return client.managedBroadcastDelivery.create({
      data: {
        broadcastId: item.broadcastId,
        targetChatId: sourceChatId,
        occurrenceIndex: 1,
        contentRevisionId: item.envelopeRevisionId,
        status,
        ...(status === 'SENDING'
          ? { attemptCount: 1, lockedAt: decisionAt, lockToken: `synthetic-${randomUUID()}` }
          : {}),
        ...(sent
          ? {
              attemptCount: 1,
              botId: item.botId,
              sentAt: new Date(decisionAt.getTime() - 1_000),
              remoteMessageId: `synthetic-${randomUUID()}`,
              remoteMessageVerifiedAt: decisionAt,
            }
          : {}),
        ...(item.profile === 'PUBLIK_V1'
          ? {
              dialogBotId,
              publisherDialogContext: { version: 1, dialogBotId, buttons: [] },
              publicationPolicyRevision: 0,
            }
          : {}),
        ...options,
      },
    });
  }

  async function probe(
    item: Occurrence,
    mode: Mode = '100',
    client: QueryReader = db,
  ): Promise<PublicationOccurrenceRollupNoopSnapshot | undefined> {
    const rows = await client.$queryRaw<PublicationOccurrenceRollupNoopSnapshot[]>(
      buildPublicationOccurrenceRollupNoopQuery(item.occurrenceId, mode),
    );
    expect(rows.length).toBeLessThanOrEqual(1);
    return rows[0];
  }

  const unchanged = async (
    item: Occurrence,
    mode: Mode = '100',
    now = decisionAt,
    client: QueryReader = db,
  ) => isUnchangedPublicationOccurrenceRollup(await probe(item, mode, client), now);

  function original(client: Pick<Prisma.TransactionClient, 'publicationOccurrence'>, id: string) {
    return client.publicationOccurrence.findUniqueOrThrow({
      where: { id },
      include: {
        legacyBroadcasts: {
          include: {
            deliveries: {
              select: {
                status: true,
                targetChatId: true,
                lastErrorCode: true,
                lastError: true,
                remoteMessageId: true,
                remoteMessageVerifiedAt: true,
                remoteMessageVerificationAttemptCount: true,
                remoteMessageVerificationAbsentCount: true,
                remoteMessageVerificationPresentCount: true,
                remoteMessageVerificationAttemptedAt: true,
                remoteMessageVerificationNextAt: true,
                remoteMessageVerificationSource: true,
              },
            },
          },
        },
      },
    });
  }

  async function identity(item: Occurrence, client: QueryReader = db) {
    return client.$queryRaw<
      Array<{ status: PublicationOccurrenceStatus; updatedAt: Date; xmin: string; ctid: string }>
    >(Prisma.sql`
      SELECT status, updated_at AS "updatedAt", xmin::text, ctid::text
      FROM publication_occurrences WHERE id = ${item.occurrenceId}
    `);
  }

  async function assertOriginal(
    item: Occurrence,
    mode: Mode,
    client: Prisma.TransactionClient,
  ): Promise<void> {
    const snapshot = await probe(item, mode, client);
    const old = await original(client, item.occurrenceId);
    expect(isUnchangedPublicationOccurrenceRollup(snapshot, decisionAt)).toBe(true);
    expect(
      resolvePublicationOccurrenceRollupStatus(old.legacyBroadcasts, old.scheduledAt, decisionAt),
    ).toBe(old.status);
    expect(
      findFullPublicationRouteOutageTarget(
        old.legacyBroadcasts.flatMap((broadcast) => broadcast.deliveries),
      ),
    ).toBeNull();
  }

  async function expectEquivalentNoWrite(
    item: Occurrence,
    mode: Mode = '100',
    client?: Prisma.TransactionClient,
  ) {
    const before = await identity(item, client ?? db);
    if (client) {
      // FLAG: Reuse a caller-owned snapshot; opening a nested root transaction
      // would miss its uncommitted native fixture and break the comparison oracle.
      await assertOriginal(item, mode, client);
    } else {
      await db.$transaction((tx) => assertOriginal(item, mode, tx), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 15_000,
      });
    }
    expect(await identity(item, client ?? db)).toEqual(before);
  }

  async function ensureDesignatedChats() {
    const created = await db.chat.createManyAndReturn({
      data: (['CHAT', 'CHANNEL'] as const).map((entityType) => ({
        id: designated[entityType],
        entityType,
        title: 'Synthetic designated no-op fixture',
      })),
      skipDuplicates: true,
      select: { id: true },
    });
    ownedChatIds.push(...created.map((row) => row.id));
    for (const entityType of ['CHAT', 'CHANNEL'] as const)
      expect(
        (await db.chat.findUniqueOrThrow({ where: { id: designated[entityType] } })).entityType,
      ).toBe(entityType);
  }

  async function designatedEnvelope(
    parent: Occurrence,
    entityType: 'CHAT' | 'CHANNEL' = 'CHAT',
    client: Prisma.TransactionClient = db,
  ) {
    return envelope(parent, { entityType, savedTargets: [designated[entityType]] }, client);
  }

  async function explain(item: Occurrence, mode: Mode = '100', client: QueryReader = db) {
    // FLAG: ANALYZE is restricted to the disposable local race_test database above.
    return client.$queryRaw<Explained>(
      Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${buildPublicationOccurrenceRollupNoopQuery(item.occurrenceId, mode)}`,
    );
  }

  function expectBoundedPlan(plan: Explained, mode: Mode, requirePrimaryKey = false) {
    console.info('Publication occurrence rollup no-op full local plan', JSON.stringify(plan));
    const nodes = planNodes(plan);
    const scans = nodes.filter((node) => node['Relation Name'] && node['Actual Loops'] > 0);
    console.info(
      'Publication occurrence rollup no-op local plan',
      JSON.stringify({
        mode,
        executionMs: plan[0]!['QUERY PLAN'][0]!['Execution Time'],
        scans: scans.map((node) => ({
          relation: node['Relation Name'],
          alias: node.Alias,
          index: node['Index Name'],
          rows: node['Actual Rows'],
          loops: node['Actual Loops'],
          examined: examined(node),
          heapFetches: node['Heap Fetches'] ?? 0,
          buffers: (node['Shared Hit Blocks'] ?? 0) + (node['Shared Read Blocks'] ?? 0),
        })),
      }),
    );
    for (const node of scans) {
      if (node['Relation Name'] === 'pg_class') {
        expectBoundedCatalogScan(node);
        continue;
      }
      if (node['Node Type'] === 'Seq Scan') {
        expectBoundedMicroScan(node);
      } else if (node['Node Type'] === 'Bitmap Heap Scan') {
        // FLAG: Permit only the same <=2 exact envelope identities through one
        // lossless unique-key bitmap; global status intersections remain refused.
        expectBoundedEnvelopeBitmap(node);
      } else {
        expect(node['Node Type']).toMatch(/^Index (Only )?Scan$/u);
      }
      expect(node['Rows Removed by Index Recheck'] ?? 0).toBe(0);
      expect(node['Shared Hit Blocks'] ?? 0).toBeLessThan(256);
      expect(node['Shared Read Blocks'] ?? 0).toBeLessThan(256);
    }
    expectOccurrenceSeek(nodes, requirePrimaryKey);
    const deliveryScans = scans.filter(
      (node) => node['Relation Name'] === 'managed_broadcast_deliveries',
    );
    expect(deliveryScans.length).toBeGreaterThan(0);
    for (const node of deliveryScans) {
      if (node.Alias === 'recipient_key' || node.Alias === 'recipient_saved') {
        expect(mode).toBe('test');
        if (node.Alias === 'recipient_key') expectRecipientKeySeek(node, nodes);
        else expectRecipientMetadataSeek(node, nodes);
        continue;
      }
      expect(node['Rows Removed by Filter'] ?? 0).toBe(0);
      expect(node['Index Name']).toMatch(
        /^managed_broadcast_deliveries_broadcast_occurrence_(?:target_key|status_idx)$/u,
      );
      const condition = node['Index Cond'] ?? '';
      expect(condition).toContain('broadcast_id');
      const witness = condition.includes('occurrence_index');
      expect(witness).toBe(true);
      if (witness) {
        expect(node['Index Name']).toBe(
          'managed_broadcast_deliveries_broadcast_occurrence_status_idx',
        );
        // FLAG: Seek the first composite key at/after this exact tuple under LIMIT 1.
        // Identity equality belongs after the cap; a base residual filter is unbounded.
        const bounds = [
          ...condition.matchAll(
            /ROW\(broadcast_id, occurrence_index, status\) >= ROW\((envelope(?:_\d+)?)\.id, 1, '(PENDING|SENDING)'::"ManagedBroadcastDeliveryStatus"\)/gu,
          ),
        ];
        expect(bounds).toHaveLength(1);
        expect(condition).not.toContain('<=');
        expect(condition).not.toContain(' AND ');
        const cap = nodes.find((candidate) => candidate.Plans?.includes(node));
        expect(cap?.['Node Type']).toBe('Limit');
        expect(cap?.Plans).toHaveLength(1);
        expect(cap?.['Actual Rows']).toBeLessThanOrEqual(1);
        expect(cap?.['Actual Loops']).toBeLessThanOrEqual(2);
        expect(node['Actual Rows']).toBeLessThanOrEqual(1);
      }
      expect(examined(node)).toBeLessThanOrEqual(witness ? 2 : 6);
      expect(node['Actual Loops']).toBeLessThanOrEqual(2);
      expect(node['Heap Fetches'] ?? 0).toBeLessThanOrEqual(witness ? 2 : 6);
    }
    const broadcasts = scans.filter((node) => node['Relation Name'] === 'managed_broadcasts');
    expect(broadcasts.length).toBeGreaterThan(0);
    for (const node of broadcasts) {
      if (node['Node Type'] === 'Seq Scan') {
        expectBoundedMicroScan(node);
        continue;
      }
      const seek =
        node['Node Type'] === 'Bitmap Heap Scan'
          ? node.Plans!.find((child) => child['Node Type'] === 'Bitmap Index Scan')!
          : node;
      if (seek['Index Name'] === 'managed_broadcasts_pkey') {
        expect(mode).toBe('test');
        expect(seek['Node Type']).toBe('Index Scan');
        expect(seek['Index Cond']).toBe('(id = envelope_id.id)');
        expect(seek.Filter).toBeUndefined();
        expect(seek['Actual Rows']).toBeLessThanOrEqual(1);
      } else {
        expect(seek['Index Name']).toBe('managed_broadcasts_pub_occurrence_entity_key');
        expect(seek['Index Cond']).toContain('publication_occurrence_id');
      }
      // FLAG: The identity seek has at most two rows; test metadata/status filters may
      // reject those already-bounded rows without searching additional history.
      expect(examined(node)).toBeLessThanOrEqual(2);
      expect(node['Actual Loops']).toBeLessThanOrEqual(2);
    }
    if (mode !== 'test') {
      expect(nodes.some((node) => node['Relation Name'] === 'publication_targets')).toBe(false);
      expect(nodes.some((node) => node['Node Type'] === 'Function Scan')).toBe(false);
    }
  }

  function expectUnsupportedStatisticsPlan(plan: Explained): void {
    console.info('Publication rollup unsupported-statistics local plan', JSON.stringify(plan));
    const nodes = planNodes(plan);
    const catalog = nodes.filter(
      (node) => node['Relation Name'] === 'pg_class' && node['Actual Loops'] > 0,
    );
    expect(catalog).toHaveLength(1);
    expectBoundedCatalogScan(catalog[0]!);
    const history = nodes.filter(
      (node) =>
        (node['Relation Name'] && node['Relation Name'] !== 'pg_class') ||
        node['Node Type'] === 'Bitmap Index Scan',
    );
    expect(history.length).toBeGreaterThan(0);
    for (const node of history) {
      expect(node['Actual Loops']).toBe(0);
      expect(node['Actual Rows']).toBe(0);
      expect(node['Shared Hit Blocks'] ?? 0).toBe(0);
      expect(node['Shared Read Blocks'] ?? 0).toBe(0);
    }
  }

  it('keeps rollout off free of SQL and observations with a real database client', async () => {
    const item = await occurrence();
    await delivery(await envelope(item));
    const logger = { log: jest.fn() };
    const reader = new PublicationOccurrenceRollupNoopReader(db, 'off', logger);
    queries.length = 0;
    expect(await reader.canSkip(item.occurrenceId)).toBe(false);
    expect(queries).toHaveLength(0);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('uses one actual scalar SQL read and preserves row identity through the Reader boundary', async () => {
    const item = await occurrence({ scheduledAt: new Date(Date.now() - 60_000) });
    await delivery(await envelope(item));
    const reader = new PublicationOccurrenceRollupNoopReader(db, '100', { log: () => undefined });
    const before = await identity(item);
    queries.length = 0;
    expect(await reader.canSkip(item.occurrenceId)).toBe(true);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.query.trimStart()).toMatch(/^WITH rollup_scope/u);
    expect(await identity(item)).toEqual(before);
  });

  it('propagates a real aborted-transaction SQL error without a fallback or duplicate read', async () => {
    const item = await occurrence();
    await delivery(await envelope(item));
    await db.$transaction(async (tx) => {
      await expect(tx.$executeRawUnsafe('SELECT 1 / 0')).rejects.toBeDefined();
      // FLAG: Prisma query events omit failed driver-adapter queries. Count the
      // actual generic query boundary while retaining the real aborted transaction.
      const attempted = jest.fn((_query: TemplateStringsArray | Prisma.Sql) => undefined);
      const counted: QueryReader = {
        $queryRaw<T = unknown>(
          query: TemplateStringsArray | Prisma.Sql,
          ...values: unknown[]
        ): Prisma.PrismaPromise<T> {
          attempted(query);
          return tx.$queryRaw<T>(query, ...values);
        },
      };
      const reader = new PublicationOccurrenceRollupNoopReader(counted, '100', {
        log: () => undefined,
      });
      await expect(reader.canSkip(item.occurrenceId)).rejects.toMatchObject({ code: 'P2010' });
      expect(attempted).toHaveBeenCalledTimes(1);
      expect(attempted.mock.calls[0]![0]).toMatchObject({
        sql: expect.stringMatching(/^\s*WITH rollup_scope/u),
      });
    });
  });

  it.each<ManagedBroadcastStatus>(['ACTIVE', 'PARTIAL', 'FAILED', 'COMPLETED', 'CANCELED'])(
    'proves SENDING with parent %s in the same old/new PostgreSQL snapshot without a write',
    async (status) => {
      const item = await occurrence();
      const linked = await envelope(item, { status });
      await delivery(linked, { status: 'SENDING' });
      expect(await probe(item)).toMatchObject({ enrolled: true, hasSending: true });
      await expectEquivalentNoWrite(item);
    },
  );

  it('proves ACTIVE/PENDING despite a future retry while preserving the old saved status', async () => {
    const item = await occurrence();
    const linked = await envelope(item);
    await delivery(linked, { nextAttemptAt: new Date(decisionAt.getTime() + 60_000) });
    expect(await probe(item)).toMatchObject({ enrolled: true, hasActivePending: true });
    await expectEquivalentNoWrite(item);
  });

  it.each<ManagedBroadcastStatus>(['PARTIAL', 'FAILED', 'COMPLETED', 'CANCELED'])(
    'conservatively falls back for PENDING under %s without a SENDING witness',
    async (status) => {
      const item = await occurrence();
      await delivery(await envelope(item, { status }));
      expect(await unchanged(item)).toBe(false);
    },
  );

  it.each([-1, 0, 1])(
    'uses the explicit post-read clock at scheduledAt delta %i ms',
    async (delta) => {
      const scheduledAt = new Date(decisionAt.getTime() + delta);
      const expected = delta > 0 ? 'SCHEDULED' : 'IN_PROGRESS';
      const item = await occurrence({ scheduledAt, status: expected });
      await delivery(await envelope(item));
      await expectEquivalentNoWrite(item);
      const wrong = expected === 'SCHEDULED' ? 'IN_PROGRESS' : 'SCHEDULED';
      await db.publicationOccurrence.update({
        where: { id: item.occurrenceId },
        data: { status: wrong },
      });
      expect(await unchanged(item)).toBe(false);
    },
  );

  it('falls back when the clock crosses the scheduled boundary after the scalar read', async () => {
    const scheduledAt = new Date(decisionAt.getTime() + 1);
    const item = await occurrence({ scheduledAt, status: 'SCHEDULED' });
    await delivery(await envelope(item));
    const snapshot = await probe(item);
    expect(isUnchangedPublicationOccurrenceRollup(snapshot, decisionAt)).toBe(true);
    expect(isUnchangedPublicationOccurrenceRollup(snapshot, scheduledAt)).toBe(false);
  });

  it.each<PublicationOccurrenceStatus>(['SENT', 'PARTIAL', 'FAILED', 'AMBIGUOUS', 'CANCELED'])(
    'never shortcuts a saved terminal/review status %s',
    async (status) => {
      const item = await occurrence({ status });
      await delivery(await envelope(item), { status: 'SENDING' });
      expect(await unchanged(item)).toBe(false);
    },
  );

  it('does not invent a witness for missing, empty or legacy-routed occurrences', async () => {
    expect(await unchanged({ ...root, occurrenceId: `missing-${randomUUID()}` })).toBe(false);
    const empty = await occurrence();
    expect(await unchanged(empty)).toBe(false);
    await envelope(empty);
    expect(await unchanged(empty)).toBe(false);
    const legacy = await occurrence({
      publication: await publication(randomUUID(), 'LEGACY_ROUTED'),
    });
    await delivery(await envelope(legacy));
    expect(await unchanged(legacy)).toBe(false);
  });

  it('refuses an absent occurrence beside an enrolled neighbor with real pending work', async () => {
    const prefix = `rollup-neighbor-${randomUUID()}-`;
    const neighbor = await occurrence({ id: `${prefix}b` });
    await delivery(await designatedEnvelope(neighbor), { targetChatId: designated.CHAT });
    const before = await identity(neighbor);
    const absent = `${prefix}a`;
    const next = await db.publicationOccurrence.findFirst({
      where: { id: { gte: absent } },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    expect(next?.id).toBe(neighbor.occurrenceId);
    for (const mode of ['100', 'test'] as const) {
      await expectEquivalentNoWrite(neighbor, mode);
      for (const occurrenceId of [absent, `${prefix}c`]) {
        expect(await probe({ ...neighbor, occurrenceId }, mode)).toBeUndefined();
        expect(await unchanged({ ...neighbor, occurrenceId }, mode)).toBe(false);
      }
    }
    expect(await identity(neighbor)).toEqual(before);
  });

  it('cleans trigger-attributed deliveries in pages while preserving another publication', async () => {
    const owned = await occurrence();
    const ownedEnvelope = await envelope(owned);
    const foreign = await occurrence({ publication: await publication() });
    const foreignDelivery = await delivery(await envelope(foreign));
    await db.managedBroadcastDelivery.createMany({
      data: Array.from({ length: 501 }, (_, index) => ({
        broadcastId: ownedEnvelope.broadcastId,
        occurrenceIndex: 1,
        targetChatId: `synthetic-cleanup-${index}`,
        contentRevisionId: owned.revisionId,
        dialogBotId,
        publisherDialogContext: { version: 1, dialogBotId, buttons: [] },
        publicationPolicyRevision: 0,
      })),
    });
    expect(
      await db.managedBroadcastDelivery.count({
        where: {
          broadcastId: ownedEnvelope.broadcastId,
          publicationOccurrenceId: owned.occurrenceId,
        },
      }),
    ).toBe(501);
    const before = await identity(foreign);
    expect(await cleanupOwnedFixture([owned.publicationId], [])).toEqual({ deliveryCount: 501 });
    expect(
      await db.managedBroadcastDelivery.count({
        where: { broadcastId: ownedEnvelope.broadcastId },
      }),
    ).toBe(0);
    expect(await db.publication.findUnique({ where: { id: owned.publicationId } })).toBeNull();
    expect(
      await db.managedBroadcastDelivery.findUnique({ where: { id: foreignDelivery.id } }),
    ).not.toBeNull();
    expect(await identity(foreign)).toEqual(before);
  });

  it.each(['SENT', 'FAILED', 'AMBIGUOUS', 'CANCELED'] as const)(
    'retains the old reader for a sole %s delivery',
    async (status) => {
      const item = await occurrence();
      await delivery(await envelope(item), { status });
      expect(await unchanged(item)).toBe(false);
      const old = await original(db, item.occurrenceId);
      const expected = resolvePublicationOccurrenceRollupStatus(
        old.legacyBroadcasts,
        old.scheduledAt,
      );
      await rollupPublicationOccurrence(
        db as Parameters<typeof rollupPublicationOccurrence>[0],
        item.occurrenceId,
      );
      expect((await identity(item))[0]!.status).toBe(expected);
    },
  );

  it.each([
    { status: 'IN_PROGRESS', scheduledAt: '2020-01-01T00:00:00.000Z' },
    { status: 'SCHEDULED', scheduledAt: '2100-01-01T00:00:00.000Z' },
  ] as const)(
    'keeps the exported full fallback unchanged for an equivalent $status witness',
    async ({ status, scheduledAt }) => {
      const item = await occurrence({ status, scheduledAt: new Date(scheduledAt) });
      await delivery(await envelope(item), { status: 'SENDING' });
      await expectEquivalentNoWrite(item);
      const before = await identity(item);
      await rollupPublicationOccurrence(
        db as Parameters<typeof rollupPublicationOccurrence>[0],
        item.occurrenceId,
      );
      expect(await identity(item)).toEqual(before);
    },
  );

  it('retains automated verification and full-route-outage decisions on the old reader', async () => {
    const verification = await occurrence();
    await delivery(await envelope(verification), {
      status: 'SENT',
      remoteMessageVerifiedAt: null,
      remoteMessageVerificationNextAt: new Date(decisionAt.getTime() + 60_000),
    });
    expect(await unchanged(verification)).toBe(false);
    const outage = await occurrence();
    await delivery(await envelope(outage, { status: 'FAILED' }), {
      status: 'FAILED',
      lastErrorCode: MAX_ACTION_NO_EXECUTABLE_ROUTE_ERROR_CODE,
    });
    expect(await unchanged(outage)).toBe(false);
    const retained = await original(db, outage.occurrenceId);
    expect(
      findFullPublicationRouteOutageTarget(
        retained.legacyBroadcasts.flatMap((broadcast) => broadcast.deliveries),
      ),
    ).toBe(sourceChatId);
  });

  it('uses real linked envelopes instead of the legacy pointer, including the second envelope', async () => {
    const foreign = await occurrence();
    const unrelated = await envelope(foreign);
    await delivery(unrelated, { status: 'SENDING' });
    const item = await occurrence();
    const first = await envelope(item, { status: 'FAILED' });
    await delivery(first, { status: 'FAILED' });
    await db.publicationOccurrence.update({
      where: { id: item.occurrenceId },
      data: { legacyBroadcastId: unrelated.broadcastId },
    });
    expect(await unchanged(item)).toBe(false);
    const second = await envelope(item, { entityType: 'CHANNEL', status: 'CANCELED' });
    await delivery(second, { status: 'SENDING' });
    await expectEquivalentNoWrite(item);
  });

  it('does not use retained occurrence-index 2 work as the positive witness', async () => {
    const item = await occurrence();
    const linked = await envelope(item);
    await delivery(linked, { occurrenceIndex: 2, status: 'SENDING' });
    expect(await unchanged(item)).toBe(false);
    await delivery(linked, { occurrenceIndex: 1 });
    await expectEquivalentNoWrite(item);
  });

  it.each(['CHAT', 'CHANNEL', 'BOTH'] as const)(
    'enrolls the exact saved %s occurrence without requiring current publication targets',
    async (kind) => {
      await ensureDesignatedChats();
      const item = await occurrence();
      for (const entityType of kind === 'BOTH' ? (['CHAT', 'CHANNEL'] as const) : [kind]) {
        const linked = await designatedEnvelope(item, entityType);
        await delivery(linked, { targetChatId: designated[entityType] });
      }
      expect(
        await db.publicationTarget.count({ where: { publicationId: root.publicationId } }),
      ).toBe(0);
      await expectEquivalentNoWrite(item, 'test');
    },
  );

  it('checks both saved envelopes of this occurrence even if only one supplies the witness', async () => {
    const item = await occurrence();
    await delivery(await designatedEnvelope(item), { targetChatId: designated.CHAT });
    const second = await envelope(item, { entityType: 'CHANNEL', savedTargets: [sourceChatId] });
    expect(await unchanged(item, 'test')).toBe(false);
    await db.managedBroadcast.update({
      where: { id: second.broadcastId },
      data: { targetChatIds: [designated.CHANNEL] },
    });
    // FLAG: An empty sibling is allowed; the independent positive proof still needs real work.
    await expectEquivalentNoWrite(item, 'test');
    await delivery(second, { targetChatId: sourceChatId, status: 'SENT' });
    expect(await unchanged(item, 'test')).toBe(false);
  });

  it.each([
    ['foreign', ['-999999']],
    ['mixed', [designated.CHAT, '-999999']],
    ['wrong entity', [designated.CHANNEL]],
    ['empty', []],
    ['object', { target: designated.CHAT }],
    ['string', designated.CHAT],
  ] satisfies Array<[string, Prisma.InputJsonValue]>)(
    'refuses the %s saved audience before considering a matching delivery',
    async (_label, savedTargets) => {
      const item = await occurrence();
      await delivery(await envelope(item, { savedTargets }), { targetChatId: designated.CHAT });
      expect(await unchanged(item, 'test')).toBe(false);
      expect(await unchanged(item, '100')).toBe(true);
    },
  );

  it('refuses apply-to-all and a historical envelope content revision mismatch', async () => {
    const item = await occurrence();
    const linked = await designatedEnvelope(item);
    await delivery(linked, { targetChatId: designated.CHAT });
    await db.managedBroadcast.update({
      where: { id: linked.broadcastId },
      data: { applyToAllChats: true },
    });
    expect(await unchanged(item, 'test')).toBe(false);
    const next = await db.publicationContentRevision.create({
      data: { publicationId: root.publicationId, revision: 2, text: 'Synthetic newer revision' },
    });
    await db.managedBroadcast.update({
      where: { id: linked.broadcastId },
      data: { applyToAllChats: false, publicationContentRevisionId: next.id },
    });
    expect(await unchanged(item, 'test')).toBe(false);
    expect(await unchanged(item, '100')).toBe(true);
  });

  it('rejects retained older delivery revisions through the unfiltered recipient page', async () => {
    const prior = await occurrence();
    const priorEnvelope = await designatedEnvelope(prior);
    const receipt = await delivery(priorEnvelope, {
      occurrenceIndex: 2,
      targetChatId: designated.CHAT,
      status: 'SENT',
    });
    const next = await db.publicationContentRevision.create({
      data: { publicationId: root.publicationId, revision: 2, text: 'Synthetic newer revision' },
    });
    await db.publication.update({
      where: { id: root.publicationId },
      data: { canonicalContentRevisionId: next.id },
    });
    await db.publicationOccurrence.update({
      where: { id: prior.occurrenceId },
      data: { contentRevisionId: next.id },
    });
    await db.managedBroadcast.update({
      where: { id: priorEnvelope.broadcastId },
      data: { publicationContentRevisionId: next.id },
    });
    const item = { ...prior, revisionId: next.id };
    const linked = { ...priorEnvelope, revisionId: next.id, envelopeRevisionId: next.id };
    await delivery(linked, { targetChatId: designated.CHAT });
    expect(
      (await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: receipt.id } }))
        .contentRevisionId,
    ).toBe(root.revisionId);
    expect(await unchanged(item, 'test')).toBe(false);
    expect(await unchanged(item, '100')).toBe(true);
  });

  it.each([0, 1, 2, 3])(
    'bounds the complete saved recipient membership at page size %i',
    async (size) => {
      const item = await occurrence();
      const prefix = `synthetic-recipient-neighbor-${randomUUID()}-`;
      const linked = await envelope(item, {
        id: `${prefix}b`,
        savedTargets: [designated.CHAT],
      });
      for (const suffix of ['a', 'c']) {
        const foreign = await envelope(await occurrence(), { id: `${prefix}${suffix}` });
        await delivery(foreign, { targetChatId: sourceChatId, status: 'SENDING' });
      }
      for (let index = 1; index <= size; index += 1)
        await delivery(linked, { occurrenceIndex: index, targetChatId: designated.CHAT });
      expect(await unchanged(item, 'test')).toBe(size > 0 && size <= 2);
    },
  );

  it('rejects a foreign recipient even with a valid saved JSON and a matching first recipient', async () => {
    const item = await occurrence();
    const linked = await designatedEnvelope(item);
    await delivery(linked, { targetChatId: designated.CHAT });
    await delivery(linked, { targetChatId: sourceChatId, status: 'SENT' });
    expect(await unchanged(item, 'test')).toBe(false);
    expect(await unchanged(item, '100')).toBe(true);
  });

  it('uses this saved occurrence after current targets/content and foreign history change', async () => {
    const item = await occurrence();
    await delivery(await designatedEnvelope(item), { targetChatId: designated.CHAT });
    await db.publicationTarget.create({
      data: {
        publicationId: root.publicationId,
        targetChatId: sourceChatId,
        entityType: 'CHAT',
        position: 0,
      },
    });
    const next = await db.publicationContentRevision.create({
      data: {
        publicationId: root.publicationId,
        revision: 2,
        text: 'Synthetic editable current revision',
      },
    });
    await db.publication.update({
      where: { id: root.publicationId },
      data: { canonicalContentRevisionId: next.id },
    });
    const history = await occurrence({ status: 'SENT' });
    await delivery(await envelope(history), { status: 'SENT' });
    await retainOwnedParentHistory(history);
    await expectEquivalentNoWrite(item, 'test');
    const plan = await explain(item, 'test');
    expectBoundedPlan(plan, 'test', true);
    const nodes = planNodes(plan);
    expect(nodes.some((node) => node['Relation Name'] === 'publication_targets')).toBe(false);
    expectOccurrenceSeek(nodes, true);
    for (const scan of nodes.filter(
      (node) => node['Relation Name'] === 'publication_occurrences' && node['Actual Loops'] > 0,
    )) {
      expect(scan['Shared Hit Blocks'] ?? 0).toBeLessThan(32);
      expect(scan['Shared Read Blocks'] ?? 0).toBeLessThan(32);
    }
  });

  it('does not infer saved test enrollment from the current designated publication targets', async () => {
    await ensureDesignatedChats();
    const item = await occurrence();
    await delivery(await envelope(item));
    await db.publicationTarget.create({
      data: {
        publicationId: root.publicationId,
        targetChatId: designated.CHAT,
        entityType: 'CHAT',
        position: 0,
      },
    });
    expect(await unchanged(item, 'test')).toBe(false);
  });

  it('rejects compressed and uncompressed oversized saved JSON before audience work', async () => {
    const item = await occurrence();
    const linked = await designatedEnvelope(item);
    await delivery(linked, { targetChatId: designated.CHAT });
    const uncompressed = Array.from({ length: 24 }, () => randomUUID());
    await db.managedBroadcast.update({
      where: { id: linked.broadcastId },
      data: { targetChatIds: uncompressed },
    });
    const stored = () =>
      db.$queryRaw<Array<{ compression: string | null; bytes: number }>>(Prisma.sql`
      SELECT pg_column_compression(target_chat_ids) AS compression,
        pg_column_size(target_chat_ids) AS bytes
      FROM managed_broadcasts WHERE id = ${linked.broadcastId}
    `);
    expect((await stored())[0]).toMatchObject({ compression: null });
    expect((await stored())[0]!.bytes).toBeGreaterThan(256);
    expect(await unchanged(item, 'test')).toBe(false);
    await db.$executeRaw(Prisma.sql`
      UPDATE managed_broadcasts SET target_chat_ids = (
        SELECT jsonb_agg(${designated.CHAT}::text) FROM generate_series(1, 50000)
      ) WHERE id = ${linked.broadcastId}
    `);
    expect((await stored())[0]!.compression).not.toBeNull();
    expect(await unchanged(item, 'test')).toBe(false);
    expect(await unchanged(item, '100')).toBe(true);
  });

  it('keeps independent native 5/25/100 cohorts stable across occurrences at exact hash boundaries', async () => {
    const botId = root.botId!;
    for (const bucket of [4, 5, 24, 25, 99]) {
      let vector = '';
      for (let attempt = 0; attempt < 10_000; attempt += 1) {
        const id = `${root.publicationId}-${bucket}-${attempt}`;
        const key = `publisher-occurrence-rollup-noop-v1:${Buffer.byteLength(botId)}:${botId}:${Buffer.byteLength(id)}:${id}`;
        if (createHash('md5').update(key).digest().readUInt32BE(0) % 100 === bucket) {
          vector = id;
          break;
        }
      }
      expect(vector).not.toBe('');
      const parent = await publication(vector, 'PUBLIK_V1', botId);
      for (let index = 0; index < 2; index += 1) {
        const item = await occurrence({ publication: parent });
        await delivery(await envelope(item));
        for (const mode of ['5', '25', '100'] as const) {
          expect(await unchanged(item, mode)).toBe(bucket < Number(mode));
          expect(await unchanged(item, mode)).toBe(bucket < Number(mode));
        }
      }
    }
  });

  it.each(['terminalize', 'cancel'] as const)(
    'does not block or write behind an uncommitted %s writer and observes the later commit',
    async (action) => {
      const item = await occurrence({ scheduledAt: new Date('2020-01-01T00:00:00.000Z') });
      const linked = await envelope(item);
      const recipient = await delivery(linked, { status: 'SENDING' });
      const before = await identity(item);
      const held = gate();
      const release = gate();
      const writer = db.$transaction(
        async (tx) => {
          if (action === 'cancel')
            await tx.publicationOccurrence.update({
              where: { id: item.occurrenceId },
              data: { status: 'CANCELED' },
            });
          else
            await tx.managedBroadcastDelivery.update({
              where: { id: recipient.id },
              data: {
                status: 'SENT',
                botId: item.botId,
                lockedAt: null,
                lockToken: null,
                sentAt: decisionAt,
                remoteMessageId: 'synthetic-writer-receipt',
                remoteMessageVerifiedAt: decisionAt,
              },
            });
          held.resolve();
          await release.promise;
        },
        { timeout: 15_000 },
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      let read: Promise<void> | undefined;
      let writerResult: PromiseSettledResult<unknown> | undefined;
      try {
        await Promise.race([
          held.promise,
          writer.then(() => {
            throw new Error('Writer finished before holding its barrier');
          }),
        ]);
        read = expectEquivalentNoWrite(item);
        await Promise.race([
          read,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Read-only no-op waited for a row writer')),
              2_000,
            );
          }),
        ]);
        expect(await identity(item)).toEqual(before);
      } finally {
        if (timer) clearTimeout(timer);
        release.resolve();
        // FLAG: Promise.race does not cancel SQL. Drain both operations before fixture
        // cleanup even when the independent read exceeds its expected latency bound.
        [writerResult] = await Promise.allSettled([writer, ...(read ? [read] : [])]);
      }
      if (writerResult?.status === 'rejected') throw writerResult.reason;
      expect(await unchanged(item)).toBe(false);
      // FLAG: Exercise the existing public scanner after commit with the actual exported
      // full fallback; the independent original reader remains the equivalence oracle.
      const scanner = new PublicationOccurrenceRollupScanner();
      const seen: string[] = [];
      await scanner.scan({
        prisma: db,
        rollup: async (id) => {
          seen.push(id);
          const current = { ...item, occurrenceId: id };
          if (await unchanged(current)) return;
          await rollupPublicationOccurrence(
            db as Parameters<typeof rollupPublicationOccurrence>[0],
            id,
          );
        },
        onError: (_id, error) => {
          throw error;
        },
      });
      if (action === 'terminalize') {
        expect(seen).toContain(item.occurrenceId);
        expect(
          (await db.publicationOccurrence.findUniqueOrThrow({ where: { id: item.occurrenceId } }))
            .status,
        ).toBe('SENT');
      } else {
        expect(seen).not.toContain(item.occurrenceId);
        expect(
          (await db.publicationOccurrence.findUniqueOrThrow({ where: { id: item.occurrenceId } }))
            .status,
        ).toBe('CANCELED');
      }
    },
  );

  it.each([64, 10_000, 50_000])(
    'keeps positive and negative scalar plans bounded with %i recipients plus retained index2 history',
    async (size) => {
      const item = await occurrence();
      const linked = await envelope(item, { savedTargets: { foreignLargeSnapshot: true } });
      await retainOwnedParentHistory(item);
      await db.$executeRaw(Prisma.sql`
        INSERT INTO managed_broadcast_deliveries (
          id, broadcast_id, occurrence_index, target_chat_id,
          content_revision_id, dialog_bot_id, publisher_dialog_context,
          publication_policy_revision, status, updated_at, attempt_count,
          bot_id, sent_at, remote_message_id, remote_message_verified_at,
          locked_at, lock_token
        )
        SELECT ${linked.broadcastId} || '-history-' || occurrence_index::text || '-' || n::text,
          ${linked.broadcastId}, occurrence_index, 'synthetic-rollup-target-' || n::text,
          ${linked.revisionId}, ${dialogBotId},
          ${JSON.stringify({ version: 1, dialogBotId, buttons: [] })}::jsonb,
          0, CASE WHEN occurrence_index = 1 THEN 'SENT'::"ManagedBroadcastDeliveryStatus"
            ELSE 'SENDING'::"ManagedBroadcastDeliveryStatus" END, ${decisionAt}, 1,
          ${linked.botId},
          CASE WHEN occurrence_index = 1 THEN ${decisionAt}::timestamp ELSE NULL END,
          CASE WHEN occurrence_index = 1 THEN 'synthetic-rollup-receipt-' || n::text ELSE NULL END,
          CASE WHEN occurrence_index = 1 THEN ${decisionAt}::timestamp ELSE NULL END,
          CASE WHEN occurrence_index = 2 THEN ${decisionAt}::timestamp ELSE NULL END,
          CASE WHEN occurrence_index = 2 THEN 'synthetic-rollup-held-' || n::text ELSE NULL END
        FROM generate_series(1, ${size}::integer) n
        CROSS JOIN generate_series(1, 2) occurrence_index
      `);
      // Numeric mode must not inspect saved audience JSON; both seeks are exact index1/status.
      expect(await unchanged(item)).toBe(false);
      expectBoundedPlan(await explain(item), '100', true);
      await delivery(linked, { status: 'SENDING', targetChatId: 'synthetic-rollup-late-witness' });
      await expectEquivalentNoWrite(item);
      expectBoundedPlan(await explain(item), '100', true);
      // Test enrollment rejects a large actual ledger through its unfiltered three-row page.
      await db.managedBroadcast.update({
        where: { id: linked.broadcastId },
        data: { targetChatIds: [designated.CHAT] },
      });
      expect(await unchanged(item, 'test')).toBe(false);
      expectBoundedPlan(await explain(item, 'test'), 'test', true);
      const second = await envelope(item, { entityType: 'CHANNEL' });
      await delivery(second, { status: 'SENDING' });
      expectBoundedPlan(await explain(item), '100', true);
    },
  );

  const readParentStatistics = (client: QueryReader = db) =>
    client.$queryRaw<Array<{ relation: string; estimatedRows: number }>>(Prisma.sql`
      SELECT relname AS relation, reltuples::double precision AS "estimatedRows"
      FROM pg_class
      WHERE oid IN ('publication_occurrences'::regclass, 'managed_broadcasts'::regclass)
      ORDER BY relname
    `);

  it('declines zero occurrence statistics without executing business-table probes', async () => {
    // FLAG: Preserve preceding suites' physical history. Never delete foreign rows,
    // truncate, vacuum or change the planner to obtain the empty-table precondition.
    expect(await db.publicationOccurrence.count()).toBe(0);
    expect(await db.managedBroadcast.count()).toBe(0);
    await db.$executeRawUnsafe('ANALYZE publication_occurrences, managed_broadcasts');
    const emptyParentStatistics = [
      { relation: 'managed_broadcasts', estimatedRows: 0 },
      { relation: 'publication_occurrences', estimatedRows: 0 },
    ];
    expect(await readParentStatistics()).toEqual(emptyParentStatistics);
    // FLAG: Verify zero business-table execution directly. A large uncommitted
    // fixture adds no executed probe work to this refusal branch; supported plans
    // retain the separate full-history fixture below. Keep this small fixture
    // uncommitted so background ANALYZE cannot see its new occurrence/envelope.
    const committed = await db.$transaction(
      async (tx) => {
        expect(await readParentStatistics(tx)).toEqual(emptyParentStatistics);
        const item = await occurrence({}, tx);
        const linked = await designatedEnvelope(item, 'CHAT', tx);
        expect(await tx.publicationOccurrence.count()).toBe(1);
        expect(await tx.managedBroadcast.count()).toBe(1);
        const before = await identity(item, tx);
        expect(await unchanged(item, '100', decisionAt, tx)).toBe(false);
        expectUnsupportedStatisticsPlan(await explain(item, '100', tx));
        const witness = await delivery(linked, { targetChatId: designated.CHAT }, tx);
        for (const status of ['PENDING', 'SENDING'] as const) {
          if (status === 'SENDING') {
            await tx.managedBroadcastDelivery.update({
              where: { id: witness.id },
              data: {
                status,
                attemptCount: 1,
                lockedAt: decisionAt,
                lockToken: `synthetic-unsupported-witness-${randomUUID()}`,
              },
            });
          }
          for (const mode of ['100', 'test'] as const) {
            expect(await readParentStatistics(tx)).toEqual(emptyParentStatistics);
            expect(await probe(item, mode, tx)).toBeUndefined();
            // FLAG: The existing reader remains the decision oracle when the
            // shortcut declines. Neither absence of proof nor this fixture is SEND.
            const old = await original(tx, item.occurrenceId);
            expect(
              resolvePublicationOccurrenceRollupStatus(
                old.legacyBroadcasts,
                old.scheduledAt,
                decisionAt,
              ),
            ).toBe(old.status);
            expect(
              findFullPublicationRouteOutageTarget(
                old.legacyBroadcasts.flatMap((broadcast) => broadcast.deliveries),
              ),
            ).toBeNull();
            expectUnsupportedStatisticsPlan(await explain(item, mode, tx));
            expect(await identity(item, tx)).toEqual(before);
            expect(await readParentStatistics(tx)).toEqual(emptyParentStatistics);
          }
        }
        return { item, before };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 },
    );
    expect(await identity(committed.item)).toEqual(committed.before);
  }, 60_000);

  it('bounds fresh and positive-stale seeks with 50k foreign sends and retained parents', async () => {
    // FLAG: Prepare the full native FK graph outside the proof transaction. Keep
    // per-statement chunks, exact cardinalities and the existing finite deadlines.
    expect(await db.publicationOccurrence.count()).toBe(0);
    expect(await db.managedBroadcast.count()).toBe(0);
    const history = await publication();
    const foreign = await occurrence({ publication: history });
    const foreignEnvelope = await envelope(foreign, {
      savedTargets: Array.from({ length: 50_000 }, (_, index) => `synthetic-foreign-${index + 1}`),
    });
    const prefix = `synthetic-retained-${randomUUID()}-`;
    await retainOwnedParentHistory(history, prefix);
    for (let first = 1; first <= 50_000; first += 5_000) {
      await db.$executeRaw(Prisma.sql`
        INSERT INTO managed_broadcast_deliveries (
          id, broadcast_id, occurrence_index, target_chat_id,
          content_revision_id, dialog_bot_id, publisher_dialog_context,
          publication_policy_revision, status, attempt_count, locked_at, lock_token, updated_at
        )
        SELECT ${prefix} || 'foreign-delivery-' || n::text,
          ${foreignEnvelope.broadcastId}, 1, 'synthetic-foreign-' || n::text,
          ${history.revisionId}, ${dialogBotId},
          ${JSON.stringify({ version: 1, dialogBotId, buttons: [] })}::jsonb,
          0, 'SENDING'::"ManagedBroadcastDeliveryStatus", 1,
          ${decisionAt}, ${prefix} || 'foreign-lease-' || n::text, ${decisionAt}
        FROM generate_series(${first}::integer, ${first + 4_999}::integer) n
      `);
    }
    expect(
      await db.managedBroadcastDelivery.count({
        where: {
          broadcastId: foreignEnvelope.broadcastId,
          occurrenceIndex: 1,
          status: 'SENDING',
          id: { startsWith: `${prefix}foreign-delivery-` },
          targetChatId: { startsWith: 'synthetic-foreign-' },
        },
      }),
    ).toBe(50_000);
    // FLAG: Each statistics phase owns a distinct witness key. Reusing one key
    // across phases measures accumulated invisible tuple versions as well as the
    // intended retained-history plan; that MVCC cost remains a separate limitation.
    const phases: Array<{
      phase: 'fresh' | 'positive-stale';
      item: Occurrence;
      linked: Envelope;
      before: Awaited<ReturnType<typeof identity>>;
    }> = [];
    for (const phase of ['fresh', 'positive-stale'] as const) {
      const item = await occurrence();
      const linked = await designatedEnvelope(item);
      phases.push({ phase, item, linked, before: await identity(item) });
    }
    expect(await db.publicationOccurrence.count()).toBe(10_003);
    expect(await db.managedBroadcast.count()).toBe(10_003);
    await db.$executeRawUnsafe(
      'ANALYZE publications, publication_occurrences, managed_broadcasts, managed_broadcast_deliveries',
    );
    await db.$transaction(
      async (tx) => {
        // FLAG: Only this disposable store is analyzed. Retain its ANALYZE locks
        // through both phases so background analysis cannot refresh the stale case.
        await tx.$executeRawUnsafe(
          'ANALYZE publications, publication_occurrences, managed_broadcasts, managed_broadcast_deliveries',
        );
        const positiveStatistics = await readParentStatistics(tx);
        for (const { phase, item, linked, before } of phases) {
          if (phase === 'positive-stale') {
            await retainOwnedParentHistory(history, `${prefix}appended-`, tx, 1_000, 10_001);
            expect(await tx.publicationOccurrence.count()).toBe(11_003);
            expect(await tx.managedBroadcast.count()).toBe(11_003);
          }
          const assertPhaseStatistics = async () => {
            const statistics = await readParentStatistics(tx);
            expect(statistics).toEqual(positiveStatistics);
            for (const { estimatedRows } of statistics) {
              expect(Number.isFinite(estimatedRows)).toBe(true);
              expect(estimatedRows).toBeGreaterThanOrEqual(10_000);
            }
          };
          const assertPlan = async (mode: Mode = '100') => {
            await assertPhaseStatistics();
            expectBoundedPlan(await explain(item, mode, tx), mode, true);
          };
          const assertNoWrite = async (mode: Mode = '100') => {
            await assertPhaseStatistics();
            await expectEquivalentNoWrite(item, mode, tx);
            expect(await identity(item, tx)).toEqual(before);
          };
          await assertPhaseStatistics();
          expect(await unchanged(item, '100', decisionAt, tx)).toBe(false);
          await assertPlan();
          const witness = await delivery(linked, { targetChatId: designated.CHAT }, tx);
          await assertNoWrite();
          await assertPlan();
          await tx.managedBroadcastDelivery.update({
            where: { id: witness.id },
            data: {
              status: 'SENDING',
              attemptCount: 1,
              lockedAt: decisionAt,
              lockToken: `${prefix}owned-witness`,
            },
          });
          await assertNoWrite();
          await assertPlan();
          await assertNoWrite('test');
          await assertPlan('test');
          expect(await identity(item, tx)).toEqual(before);
          await assertPhaseStatistics();
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 },
    );
    for (const { item, before } of phases) expect(await identity(item)).toEqual(before);
  }, 60_000);
});
