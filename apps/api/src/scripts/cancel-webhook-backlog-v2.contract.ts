import { createHash } from 'node:crypto';

export const BACKLOG_CANCELLATION_V2_LIMITS = {
  roots: 128,
  nominationBytes: 16 * 1024,
  applyBytes: 4 * 1024,
  previewBytes: 8 * 1024 * 1024,
  familyRows: 256,
  sqlRows: 8192,
  sqlBytes: 64 * 1024 * 1024,
  rowBytes: 320 * 1024,
  sqlPage: 200,
  selectedChildren: 4096,
  queueJobs: 500_000,
  queueBytes: 256 * 1024 * 1024,
  queuePage: 100,
  queueReplyBytes: 1024 * 1024,
  jobBytes: 256 * 1024,
  jobFields: 64,
  clientMs: 900_000,
} as const;

export type BacklogCancellationNominationV2 = {
  version: 2;
  id: string;
  cutoff: string;
  sourceSha: string;
  imageId: string;
  rootIds: string[];
};
export type BacklogCancellationApplyV2 = {
  version: 2;
  id: string;
  cutoff: string;
  sourceSha: string;
  imageId: string;
  previewSha256: string;
};
export type BacklogCancellationBindingsV2 = {
  runtimeDigest: string;
  clientSha256: string;
};
export type BacklogCancellationIssueCodeV2 =
  | 'INVALID_INPUT'
  | 'IDENTITY_MISMATCH'
  | 'ROOT_MISSING'
  | 'ROOT_INELIGIBLE'
  | 'CLAIM_MISMATCH'
  | 'SOURCE_MISMATCH'
  | 'FOREIGN_HOLD'
  | 'SCOPE_DRIFT'
  | 'CHILD_DRIFT'
  | 'UNSUPPORTED_CHILD'
  | 'SQL_PLAN'
  | 'SQL_READ_ONLY'
  | 'BUDGET'
  | 'REDIS_SHAPE'
  | 'REDIS_OVERSIZE'
  | 'EVIDENCE_MISMATCH'
  | 'OPERATION_EXISTS'
  | 'INCOMPLETE';
export type BacklogCancellationIssueV2 = {
  code: BacklogCancellationIssueCodeV2;
  rootId?: string;
  receiptId?: string;
  queue?: string;
  jobId?: string;
};
export type BacklogCancellationRootProofV2 = {
  receiptId: string;
  claimId: string;
  semanticKey: string;
  chatId: string | null;
  messageId: string | null;
  identitySha256: string;
  claimSha256: string;
  rawPayloadSha256: string;
  normalizedPayloadSha256: string;
};
export type BacklogCancellationReceiptProofV2 = {
  receiptId: string;
  identitySha256: string;
};
export type BacklogCancellationChildProofV2 = {
  queue: string;
  jobId: string;
  kind: 'WEBHOOK' | 'MAX_ACTION';
  childKey: string;
  authoritySha256: string;
  sourceReason: 'EXACT_RECEIPT' | 'ORIGINAL_SOURCE' | 'DIRECT_DELETE' | 'EXACT_SEND_PARENT';
};
// FLAG: sqlRows counts distinct observed receipt/claim/child primary identities, including rejected/missing ones.
// SQL calls/reply bytes charge every v2 observation; imported stock projection reserves an upper bound.
export type BacklogCancellationCostV2 = {
  sqlRows: number;
  sqlBytes: number;
  sqlCalls: number;
  queueJobs: number;
  queueBytes: number;
  queuePages: number;
};
export type BacklogCancellationRetainedV2 = {
  terminalReceipts: number;
  protectedJobs: number;
  unattributedJobs: number;
  lockedJobs: number;
};
export type BacklogCancellationPreviewV2 = {
  version: 2;
  kind: 'BACKLOG_CANCELLATION_PREVIEW';
  id: string;
  cutoff: string;
  sourceSha: string;
  imageId: string;
  nominationSha256: string;
  bindings: BacklogCancellationBindingsV2;
  familyPolicy: 'EXACT_OBSERVED_PENDING_FAMILY_V1';
  childPolicy: 'EXACT_SOURCE_CHILD_V1';
  snapshotAt: string;
  completedAt: string;
  decision: 'READY' | 'DENY';
  complete: boolean;
  nonAtomicOnline: true;
  stoppedRevalidationRequired: true;
  roots: BacklogCancellationRootProofV2[];
  receipts: BacklogCancellationReceiptProofV2[];
  children: BacklogCancellationChildProofV2[];
  retained: BacklogCancellationRetainedV2;
  cost: BacklogCancellationCostV2;
  issues: BacklogCancellationIssueV2[];
};
export type BacklogCancellationApplyResultV2 = {
  version: 2;
  kind: 'BACKLOG_CANCELLATION_APPLY_RESULT';
  id: string;
  previewSha256: string;
  outcome: 'APPLIED' | 'REFUSED_UNWRITTEN' | 'INCOMPLETE_WRITTEN';
  operationExists: boolean;
  sealed: boolean;
  counts: {
    receipts: number;
    projected: number;
    children: number;
    removed: number;
    retainedLocked: number;
    missingJobs: number;
  };
  issues: BacklogCancellationIssueV2[];
};
export type BacklogCancellationNoWriteProofV2 = {
  version: 2;
  kind: 'BACKLOG_CANCELLATION_NO_WRITE_PROOF';
  id: string;
  previewSha256: string;
  operationAbsent: boolean;
};
export type BacklogCancellationPreflightV2 = {
  version: 2;
  kind: 'BACKLOG_CANCELLATION_PREFLIGHT';
  id: string;
  previewSha256: string;
  valid: boolean;
};

export class BacklogCancellationRefusedV2 extends Error {
  constructor(readonly issue: BacklogCancellationIssueV2) {
    super(issue.code);
    this.name = 'BacklogCancellationRefusedV2';
  }
}

const issueCodes = new Set<BacklogCancellationIssueCodeV2>([
  'INVALID_INPUT',
  'IDENTITY_MISMATCH',
  'ROOT_MISSING',
  'ROOT_INELIGIBLE',
  'CLAIM_MISMATCH',
  'SOURCE_MISMATCH',
  'FOREIGN_HOLD',
  'SCOPE_DRIFT',
  'CHILD_DRIFT',
  'UNSUPPORTED_CHILD',
  'SQL_PLAN',
  'SQL_READ_ONLY',
  'BUDGET',
  'REDIS_SHAPE',
  'REDIS_OVERSIZE',
  'EVIDENCE_MISMATCH',
  'OPERATION_EXISTS',
  'INCOMPLETE',
]);
function refuse(): never {
  throw new BacklogCancellationRefusedV2({ code: 'INVALID_INPUT' });
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).sort().join(',') !== expected.sort().join(',')) refuse();
}
export function hasBacklogCancellationControlsV2(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
function text(value: unknown, maximum = 512): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    hasBacklogCancellationControlsV2(value) ||
    Buffer.byteLength(value) > maximum
  )
    refuse();
}
function digest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) refuse();
}
function instant(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    refuse();
}
function identity(row: Record<string, unknown>): void {
  if (
    row.version !== 2 ||
    typeof row.id !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(row.id) ||
    typeof row.sourceSha !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(row.sourceSha) ||
    typeof row.imageId !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(row.imageId)
  )
    refuse();
  instant(row.cutoff);
  if (Date.parse(row.cutoff) >= Date.now()) refuse();
}
function parse(raw: string, maximum: number): Record<string, unknown> {
  if (Buffer.byteLength(raw) > maximum) refuse();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return refuse();
  }
  if (raw !== backlogCancellationBytesV2(value)) refuse();
  return object(value);
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return refuse();
  return value;
}
function sortedUnique(values: string[]): void {
  if (values.some((value, index) => index > 0 && values[index - 1]! >= value)) refuse();
}
export function parseBacklogCancellationNominationV2(raw: string): BacklogCancellationNominationV2 {
  const row = parse(raw, BACKLOG_CANCELLATION_V2_LIMITS.nominationBytes);
  keys(row, ['version', 'id', 'cutoff', 'sourceSha', 'imageId', 'rootIds']);
  identity(row);
  const roots = list(row.rootIds, BACKLOG_CANCELLATION_V2_LIMITS.roots);
  if (!roots.length) refuse();
  for (const root of roots) text(root, 128);
  sortedUnique(roots as string[]);
  return row as BacklogCancellationNominationV2;
}
export function parseBacklogCancellationApplyV2(raw: string): BacklogCancellationApplyV2 {
  const row = parse(raw, BACKLOG_CANCELLATION_V2_LIMITS.applyBytes);
  keys(row, ['version', 'id', 'cutoff', 'sourceSha', 'imageId', 'previewSha256']);
  identity(row);
  digest(row.previewSha256);
  return row as BacklogCancellationApplyV2;
}
export function validateBacklogCancellationBindingsV2(
  value: unknown,
): BacklogCancellationBindingsV2 {
  const row = object(value);
  keys(row, ['runtimeDigest', 'clientSha256']);
  digest(row.runtimeDigest);
  digest(row.clientSha256);
  return row as BacklogCancellationBindingsV2;
}
export function validateBacklogCancellationPreviewV2(value: unknown): BacklogCancellationPreviewV2 {
  const row = object(value);
  keys(row, [
    'version',
    'kind',
    'id',
    'cutoff',
    'sourceSha',
    'imageId',
    'nominationSha256',
    'bindings',
    'familyPolicy',
    'childPolicy',
    'snapshotAt',
    'completedAt',
    'decision',
    'complete',
    'nonAtomicOnline',
    'stoppedRevalidationRequired',
    'roots',
    'receipts',
    'children',
    'retained',
    'cost',
    'issues',
  ]);
  identity(row);
  if (
    row.kind !== 'BACKLOG_CANCELLATION_PREVIEW' ||
    row.familyPolicy !== 'EXACT_OBSERVED_PENDING_FAMILY_V1' ||
    row.childPolicy !== 'EXACT_SOURCE_CHILD_V1' ||
    row.nonAtomicOnline !== true ||
    row.stoppedRevalidationRequired !== true ||
    typeof row.complete !== 'boolean' ||
    !['READY', 'DENY'].includes(String(row.decision))
  )
    refuse();
  digest(row.nominationSha256);
  validateBacklogCancellationBindingsV2(row.bindings);
  instant(row.snapshotAt);
  instant(row.completedAt);
  const roots = list(row.roots, BACKLOG_CANCELLATION_V2_LIMITS.roots);
  const rootIds: string[] = [];
  for (const value of roots) {
    const root = object(value);
    keys(root, [
      'receiptId',
      'claimId',
      'semanticKey',
      'chatId',
      'messageId',
      'identitySha256',
      'claimSha256',
      'rawPayloadSha256',
      'normalizedPayloadSha256',
    ]);
    text(root.receiptId, 128);
    text(root.claimId, 128);
    text(root.semanticKey);
    if ((root.chatId === null) !== (root.messageId === null)) refuse();
    if (root.chatId !== null) {
      text(root.chatId);
      text(root.messageId);
    }
    for (const key of [
      'identitySha256',
      'claimSha256',
      'rawPayloadSha256',
      'normalizedPayloadSha256',
    ])
      digest(root[key]);
    rootIds.push(root.receiptId);
  }
  sortedUnique(rootIds);
  const receiptIds: string[] = [];
  for (const value of list(row.receipts, BACKLOG_CANCELLATION_V2_LIMITS.sqlRows)) {
    const receipt = object(value);
    keys(receipt, ['receiptId', 'identitySha256']);
    text(receipt.receiptId, 128);
    digest(receipt.identitySha256);
    receiptIds.push(receipt.receiptId);
  }
  sortedUnique(receiptIds);
  const childIds: string[] = [];
  for (const value of list(row.children, BACKLOG_CANCELLATION_V2_LIMITS.selectedChildren)) {
    const child = object(value);
    keys(child, ['queue', 'jobId', 'kind', 'childKey', 'authoritySha256', 'sourceReason']);
    text(child.queue, 128);
    text(child.jobId);
    text(child.childKey);
    digest(child.authoritySha256);
    if (
      !['WEBHOOK', 'MAX_ACTION'].includes(String(child.kind)) ||
      !['EXACT_RECEIPT', 'ORIGINAL_SOURCE', 'DIRECT_DELETE', 'EXACT_SEND_PARENT'].includes(
        String(child.sourceReason),
      )
    )
      refuse();
    childIds.push(`${child.queue}\u0000${child.jobId}`);
  }
  sortedUnique(childIds);
  for (const [name, expected] of [
    ['retained', ['terminalReceipts', 'protectedJobs', 'unattributedJobs', 'lockedJobs']],
    ['cost', ['sqlRows', 'sqlBytes', 'sqlCalls', 'queueJobs', 'queueBytes', 'queuePages']],
  ] as const) {
    const values = object(row[name]);
    keys(values, [...expected]);
    for (const value of Object.values(values))
      if (!Number.isSafeInteger(value) || Number(value) < 0) refuse();
  }
  const issues = list(row.issues, BACKLOG_CANCELLATION_V2_LIMITS.roots + 1);
  for (const value of issues) {
    const issue = object(value);
    if (
      !issueCodes.has(issue.code as BacklogCancellationIssueCodeV2) ||
      Object.keys(issue).some(
        (key) => !['code', 'rootId', 'receiptId', 'queue', 'jobId'].includes(key),
      )
    )
      refuse();
    for (const key of ['rootId', 'receiptId', 'queue', 'jobId'])
      if (issue[key] !== undefined) text(issue[key]);
  }
  if (
    row.decision === 'READY' &&
    (!row.complete ||
      issues.length ||
      !roots.length ||
      rootIds.some((id) => !receiptIds.includes(id)))
  )
    refuse();
  if (
    Buffer.byteLength(backlogCancellationBytesV2(row)) > BACKLOG_CANCELLATION_V2_LIMITS.previewBytes
  )
    refuse();
  return row as BacklogCancellationPreviewV2;
}

export function backlogCancellationCanonicalV2(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(backlogCancellationCanonicalV2);
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(row)
        .sort()
        .map((key) => [key, backlogCancellationCanonicalV2(row[key])]),
    );
  }
  return value;
}

export function backlogCancellationBytesV2(value: unknown): string {
  return `${JSON.stringify(backlogCancellationCanonicalV2(value))}\n`;
}

export function backlogCancellationDigestV2(value: unknown): string {
  return createHash('sha256').update(backlogCancellationBytesV2(value)).digest('hex');
}
