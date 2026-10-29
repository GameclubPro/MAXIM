import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// FLAG: The stable v2 entrypoint now enforces the v3 supplementary-operation floor too.
// Retained list intents and independent policy revisions survive feature-off and rollback.
export const NETWORK_SETTINGS_V2_SOURCE_CHECKS = Object.freeze([
  [
    'apps/api/prisma/migrations/20261022130000_network_allowlist_revision/migration.sql',
    [
      'ADD COLUMN "navigation_allowlist_revision" INTEGER NOT NULL DEFAULT 0',
      'CREATE TRIGGER navigation_allowlist_revision_insert AFTER INSERT ON domain_allowlist',
      'CREATE TRIGGER navigation_allowlist_revision_delete AFTER DELETE ON domain_allowlist',
      'CREATE TRIGGER navigation_allowlist_revision_update AFTER UPDATE ON domain_allowlist',
    ],
  ],
  [
    'apps/api/src/admin/admin.module.ts',
    [
      "import { NetworkNavigationAllowlist } from './network-navigation-allowlist';",
      'NetworkNavigationAllowlist,',
    ],
  ],
  [
    'apps/api/src/admin/network-settings.service.ts',
    [
      'export const NETWORK_SETTINGS_OPERATION_READER_VERSION = 3;',
      'assertOperationReader(stored);',
      'readerVersion: V3_SECTIONS.has(request.section) ? 3 : request.navigationAllowlist ? 2 : 1',
      "code: 'NETWORK_SETTINGS_READER_UNSUPPORTED'",
      'this.allowlist.commitOnly(',
      'this.allowlist.planInTransaction(',
      'request.navigationAllowlist!',
      'recipient.navigationAllowlistWitness!',
      '...payload, navigationAllowlistImpacts: impacts',
    ],
  ],
  [
    'apps/api/src/admin/network-navigation-allowlist.ts',
    [
      'SELECT navigation_allowlist_revision AS revision FROM chats WHERE id=${chatId} FOR UPDATE',
      'take: NETWORK_ALLOWLIST_PLAN_ROW_LIMIT + 1',
      'expected.revision !== actual.revision',
      "action: 'UPDATE_DOMAIN_ALLOWLIST'",
      'await options.onCommitted?.(tx, String(recipient.revision));',
    ],
  ],
  [
    'apps/api/src/admin/admin-chat-settings.ts',
    [
      'if (params.networkWrite?.beforeWrite)',
      'await params.networkWrite.beforeWrite(tx);',
      'await params.networkWrite.onCommitted(tx, savedRevision);',
    ],
  ],
  [
    'packages/contracts/src/network-settings.ts',
    [
      "export * from './network-settings-read.js';",
      "export * from './network-settings-actions.js';",
    ],
  ],
  [
    'packages/contracts/src/network-settings-read.ts',
    [
      "export const networkNavigationAllowlistIntentSchema = z.discriminatedUnion('mode', [",
      'export const networkNavigationAllowlistWitnessSchema = z',
    ],
  ],
  [
    'apps/api/src/message-retention/eraser-control.service.ts',
    [
      'function canonicalRequest(value: UpdateMessageRetention & { operationId: string }) { return { enabled: value.enabled, hours: value.hours, expectedRevision: value.expectedRevision, operationId: value.operationId, connectWhenReady: value.connectWhenReady === true, }; }',
    ],
  ],
]);

// FLAG: Match the actual parser or writer boundary. A response or neighboring method
// with the same field name cannot prove that retained requests are safely executable.
export const NETWORK_SETTINGS_V2_SCOPED_CHECKS = Object.freeze([
  [
    'packages/contracts/src/network-settings-read.ts',
    'export const networkChatSettingsSectionSchema =',
    'export const networkChannelSettingsSectionSchema =',
    ["'speechStyle'", "'rules'", "'messageRetention'", "'advertising'"],
  ],
  [
    'packages/contracts/src/network-settings-read.ts',
    'export const networkChannelSettingsSectionSchema =',
    'export const networkSettingsSectionSchema =',
    ["'quickButtons'", "'comments'", "'postSignature'", "'postSuggestions'"],
  ],
  [
    'apps/api/src/admin/network-settings-patch.ts',
    'const CHAT_SUPPLEMENTAL_SECTIONS =',
    'const retentionPatchSchema =',
    [
      "speechStyle: ['botSpeechStyle']",
      "'rules.text'",
      "'rulesAttachViolationsEnabled'",
      "messageRetention: ['messageRetention.enabled', 'messageRetention.hours']",
      "advertising: ['advertising.enabled']",
    ],
  ],
  [
    'apps/api/src/admin/network-settings-patch.ts',
    'const CHANNEL_SECTIONS =',
    'const STOP_WORD_PATHS =',
    [
      'postSuggestions: [',
      "'postSuggestionsEnabled'",
      "'postSuggestionsRequireSubscription'",
      "'postSuggestionsDeleteOnUnsubscribe'",
      "'postSuggestionsEntryMode'",
      "'postSuggestionsButtonText'",
      "'postSuggestionsText'",
      "'engagementMessageText'",
      "'postSuggestionsDailyLimit'",
    ],
  ],
  [
    'packages/contracts/src/network-settings-read.ts',
    'export const networkSettingsRecipientSchema = z',
    'export type NetworkSettingsRecipient =',
    [
      'entityId: z.string().min(1),',
      'title: z.string(),',
      'revision: revisionSchema,',
      'stopWordsRevision: z.number().int().nonnegative().optional(),',
      'navigationAllowlistWitness: networkNavigationAllowlistWitnessSchema.optional(),',
      'rulesRevision: z.string().datetime().nullable().optional(),',
      'rulesContextDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),',
      'messageRetentionRevision: z.number().int().nonnegative().optional(),',
      'advertisingRevision: z.number().int().nonnegative().optional(),',
      '.strict()',
    ],
  ],
  [
    'packages/contracts/src/network-settings-actions.ts',
    'export const networkSettingsPreviewRequestSchema = networkSettingsReadRequestSchema',
    'export type NetworkSettingsPreviewRequest =',
    [
      '.omit({ cursor: true }).extend({',
      'operationId: z.string().uuid(),',
      'compositionVersion: z.string(),',
      'recipients: z.array(networkSettingsRecipientSchema).min(1),',
      'changes: z.array(networkSettingsChangeSchema).max(128),',
      'navigationAllowlist: networkNavigationAllowlistIntentSchema.optional(),',
      "if (value.entityType !== 'chat' || value.section !== 'links')",
      'value.recipients.some((r) => !r.navigationAllowlistWitness)',
    ],
  ],
  [
    'apps/api/src/admin/network-settings.service.ts',
    'const V3_SECTIONS = new Set([',
    'type StoredPayload = {',
    ["'speechStyle'", "'rules'", "'messageRetention'", "'advertising'", "'postSuggestions'"],
  ],
  [
    'apps/api/src/admin/network-settings.service.ts',
    'function assertOperationReader(',
    'function canonical(',
    [
      'const version = payload.readerVersion ?? 1;',
      '!Number.isInteger(version)',
      'version < 1',
      'version > NETWORK_SETTINGS_OPERATION_READER_VERSION',
      '(payload.request.navigationAllowlist && version < 2)',
      '(V3_SECTIONS.has(payload.request.section) && version < 3)',
      'throw new ConflictException(',
    ],
  ],
  [
    'apps/api/src/admin/network-settings.service.ts',
    'private async snapshot(',
    'async read(',
    [
      'rulesRevision: rules?.updatedAt.toISOString() ?? null,',
      'rulesContextDigest: digest(generatedText)',
      'navigationAllowlistWitness: witness,',
      'messageRetentionRevision: policy.revision,',
      'advertisingRevision: policy.revision,',
    ],
  ],
  [
    'apps/api/src/admin/network-settings.service.ts',
    'private async writeOne(',
    'async tick(',
    [
      'const eraserOperationId = retentionOperationId(request.operationId, recipient.entityId);',
      'const resumed = await this.retention.resumeEraserOperation(recipient.entityId, user, eraserOperationId, options,);',
      'if (resumed) return;',
      'currentRecipient.rulesRevision !== recipient.rulesRevision',
      'currentRecipient.messageRetentionRevision !== recipient.messageRetentionRevision',
      'currentRecipient.advertisingRevision !== recipient.advertisingRevision',
      'if (!this.retention || recipient.messageRetentionRevision === undefined) throw changed();',
      'expectedRevision: recipient.messageRetentionRevision,',
      'if (!this.advertising || recipient.advertisingRevision === undefined) throw changed();',
      'revision: recipient.advertisingRevision,',
      'if (recipient.rulesRevision === undefined) throw changed();',
      'validateChatRulesDraft(draft);',
      'authoredKeys: request.changes.some(',
      "(change) => change.path === 'rulesAttachViolationsEnabled',",
      "? ['rulesAttachViolationsEnabled'] : [],",
      'await options.beforeWrite?.(tx);',
      'await writeNetworkChatRulesDraft(tx, recipient.entityId, user.userId, draft, recipient.rulesRevision!,',
      '...request.changes.map((change) => change.path)',
      "...(generate ? ['rules.text', 'rules.textFormat'] : [])",
      '!recipient.rulesContextDigest',
      'currentRecipient.rulesContextDigest !== recipient.rulesContextDigest',
      'if (digest(text) !== recipient.rulesContextDigest) throw changed();',
      'await this.allowlist.assertWitnessInTransaction(tx, recipient.entityId, recipient.navigationAllowlistWitness,',
    ],
  ],
  [
    'apps/api/src/admin/network-settings.service.ts',
    "if (request.entityType === 'chat') { if (request.section === 'messageRetention') {",
    "if (request.section === 'advertising') {",
    [
      'return this.retention.update(',
      'expectedRevision: recipient.messageRetentionRevision, }, options, ).then(() => undefined)',
    ],
  ],
  [
    'apps/api/src/admin/network-settings.service.ts',
    "if (request.section === 'advertising') { if (!this.advertising || recipient.advertisingRevision === undefined) throw changed();",
    "if (request.section === 'rules') {",
    [
      'return this.advertising.update(',
      'revision: recipient.advertisingRevision, }, options, ).then(() => undefined)',
    ],
  ],
  [
    'apps/api/src/admin/network-settings.service.ts',
    "if (request.section === 'rules') { if (recipient.rulesRevision === undefined) throw changed();",
    "if (request.section === 'stopWords')",
    [
      'return this.settings.updateNetworkChatSettings(recipient.entityId, user, next as ChatSettings, { ...options,',
      'beforeWrite: async (tx) => { await options.beforeWrite?.(tx);',
      'await writeNetworkChatRulesDraft(tx,',
    ],
  ],
  [
    'apps/api/src/admin/admin-message-retention.service.ts',
    'async update(',
    'async resumeEraserOperation(',
    [
      'await this.authorize(chatId, user);',
      'const parsed = updateMessageRetentionSchema.safeParse(body);',
      'if (!parsed.success) throw new BadRequestException(parsed.error.flatten());',
      'return this.requireEraser().update(chatId, user.userId, request, networkWrite);',
    ],
  ],
  [
    'apps/api/src/admin/admin-message-retention.service.ts',
    'async resumeEraserOperation(',
    'private async useEraser(',
    [
      'await this.authorize(chatId, user);',
      'return this.requireEraser().resume(chatId, user.userId, operationId, options);',
      "if (!this.eraser) throw new ServiceUnavailableException('Ластик временно недоступен.');",
      'return this.eraser;',
    ],
  ],
  [
    'apps/api/src/message-retention/eraser-control.service.ts',
    'async resume(',
    'async update(',
    [
      'const saved = await this.operation(operationId);',
      'if (!saved) return null;',
      'if (saved.chatId !== chatId || saved.actorUserId !== actorUserId) throw new ConflictException(',
      'return this.dispatch(saved, options);',
    ],
  ],
  [
    'apps/api/src/message-retention/eraser-control.service.ts',
    'async update(',
    'private async operation(',
    [
      'this.assertExecution(); if (options?.validateOnly) { const current = await this.read(chatId);',
      'if (current.revision !== input.expectedRevision) throw new ConflictException(',
      'return current;',
      'const request = { ...input, operationId: input.operationId ?? randomUUID() };',
      'await this.prisma.$executeRaw` INSERT INTO eraser_control_operations(id, chat_id, actor_user_id, request) VALUES(${request.operationId}, ${chatId}, ${actorUserId}, ${JSON.stringify(request)}::jsonb) ON CONFLICT (id) DO NOTHING`;',
      'const saved = await this.operation(request.operationId);',
      '!saved || saved.chatId !== chatId || saved.actorUserId !== actorUserId ||',
      'JSON.stringify(canonicalRequest(saved.request)) !== JSON.stringify(canonicalRequest(request))',
      'throw new ConflictException(',
      'return this.dispatch(saved, options);',
    ],
  ],
  [
    'apps/api/src/message-retention/eraser-control.service.ts',
    'private async operation(',
    'private async dispatch(',
    [
      'const rows = await this.prisma.$queryRaw<StoredOperation[]>` SELECT id, chat_id AS "chatId", actor_user_id AS "actorUserId", request, result FROM eraser_control_operations WHERE id = ${id}`;',
      'return rows[0] ?? null;',
    ],
  ],
  [
    'apps/api/src/message-retention/eraser-control.service.ts',
    'private async dispatch(',
    'private async takeOwnership(',
    [
      'if (operation.result) { const result = messageRetentionStateSchema.parse(operation.result);',
      'if (options?.onCommitted) await this.prisma.$transaction(async (tx) => { await options.onCommitted!(tx, String(result.revision)); }); return result;',
      'this.assertExecution(); if (options?.beforeWrite) await this.prisma.$transaction(options.beforeWrite);',
      'await this.takeOwnership(operation.chatId);',
      'await this.readState(operation.chatId, true);',
      'await this.syncChat(operation.chatId);',
      'await this.syncGlobalHolds();',
      'if (options?.beforeWrite) await this.prisma.$transaction(options.beforeWrite); const state = messageRetentionStateSchema.parse(',
      "await this.request(`/chats/${encodeURIComponent(operation.chatId)}/policy`, 'PUT', { ...operation.request, actorUserId: operation.actorUserId, }),",
      'await this.prisma.$transaction(async (tx) => { await tx.$executeRaw`UPDATE eraser_control_operations SET result = ${JSON.stringify(state)}::jsonb, confirmed_at = CURRENT_TIMESTAMP WHERE id = ${operation.id}`;',
      'await tx.auditLog.create({',
      "action: 'UPDATE_MESSAGE_RETENTION'",
      "payload: { ...operation.request, executor: 'eraser', revision: state.revision },",
      'await options?.onCommitted?.(tx, String(state.revision)); }); return state;',
    ],
  ],
  [
    'apps/api/src/admin/advertising-placement.service.ts',
    'async update(',
    'async send(',
    [
      'if (networkWrite?.validateOnly)',
      '(current?.revision ?? 0) !== input.revision',
      'await this.prisma.$transaction(async (tx) => { await networkWrite?.beforeWrite?.(tx);',
      'const changed = await tx.advertisingPlacement.updateMany({ where: { chatId, revision: input.revision },',
      'if (!changed.count)',
      "action: 'ADVERTISING_PLACEMENT_SETTINGS'",
      'await networkWrite?.onCommitted?.(tx, String(input.revision + 1)); });',
    ],
  ],
  [
    'apps/api/src/admin/admin-chat-rules.ts',
    'export async function writeNetworkChatRulesDraft(',
    'export async function saveChatRulesDraft(',
    [
      'tx: Prisma.TransactionClient,',
      'expectedRevision: string | null,',
      'const normalized = validateChatRulesDraft(draft);',
      '(current?.updatedAt.toISOString() ?? null) !== expectedRevision',
      "paths.filter((path) => path.startsWith('rules.')).map((path) => path.slice(6))",
      'Object.fromEntries(Object.entries(normalized).filter(([key]) => authored.has(key)))',
      "await advanceChatMutationOrder(tx, chatId, 'RULES');",
      'const saved = await tx.chatRules.updateMany({ where: { chatId, updatedAt: current.updatedAt }, data, });',
      'if (saved.count !== 1) throw new ConflictException(',
      'await tx.chatRules.create({ data: { chatId, ...data } });',
      "await tx.auditLog.create({ data: { chatId, actorUserId, action: 'UPDATE_CHAT_RULES',",
    ],
  ],
]);

export const NETWORK_SETTINGS_V2_RUNTIME_IMPORTS = Object.freeze([
  [
    'apps/api/src/admin/admin-message-retention.service.ts',
    '../message-retention/eraser-control.service',
    ['EraserControlService'],
  ],
  [
    'apps/api/src/message-retention/eraser-control.service.ts',
    '@maxim/contracts/settings',
    ['messageRetentionStateSchema'],
  ],
  [
    'packages/contracts/src/network-settings-actions.ts',
    './network-settings-read.js',
    [
      'networkNavigationAllowlistImpactSchema',
      'networkNavigationAllowlistIntentSchema',
      'networkSettingsOperationStatusSchema',
      'networkSettingsReadRequestSchema',
      'networkSettingsRecipientSchema',
      'networkSettingsSectionSchema',
    ],
  ],
]);

function executable(source) {
  const characters = [];
  const active = [];
  let quote = null;
  let escaped = false;
  let blockComment = false;
  let lineComment = false;
  for (let at = 0; at < source.length; at++) {
    const char = source[at];
    const next = source[at + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        at++;
      }
      continue;
    }
    if (quote) {
      if (!/\s/u.test(char)) {
        characters.push(char);
        active.push(false);
      }
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      at++;
    } else if (
      (char === '/' && next === '/') ||
      (char === '-' &&
        next === '-' &&
        /^\s*$/u.test(source.slice(source.lastIndexOf('\n', at) + 1, at)))
    ) {
      lineComment = true;
      at++;
    } else if (['"', "'", '`'].includes(char)) {
      quote = char;
      characters.push(char);
      active.push(false);
    } else if (!/\s/u.test(char)) {
      characters.push(char);
      active.push(true);
    }
  }
  return { source: characters.join(''), active };
}
const normalizedFragment = (fragment) => fragment.replace(/\s+/gu, '');
const RETENTION_FACADE = 'apps/api/src/admin/admin-message-retention.service.ts';
const RETENTION_BRIDGE = 'apps/api/src/message-retention/eraser-control.service.ts';
const failure = (path, detail = '') =>
  new Error(
    `Rollback target lacks network settings v2+ readers/writers: ${path}${detail ? ` (${detail})` : ''}`,
  );

export function assertNetworkSettingsV2Source(
  commitSha,
  readSource = (path) =>
    execFileSync('git', ['show', `${commitSha}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
) {
  if (!/^[0-9a-f]{40}$/u.test(commitSha ?? '')) throw new Error('Exact source SHA required');
  const sources = new Map();
  const sourceFor = (path) => {
    if (!sources.has(path)) {
      let source;
      try {
        source = readSource(path);
      } catch {
        throw failure(path);
      }
      if (typeof source !== 'string') throw failure(path);
      sources.set(path, executable(source));
    }
    return sources.get(path);
  };
  const findFragment = (value, fragment, from = 0, requireActive = false) => {
    const needle = normalizedFragment(fragment);
    for (
      let at = value.source.indexOf(needle, from);
      at >= 0;
      at = value.source.indexOf(needle, at + 1)
    )
      if (!requireActive || value.active[at]) return at;
    return -1;
  };
  const requireFragments = (path, value, fragments) => {
    const executableRetention = path === RETENTION_FACADE || path === RETENTION_BRIDGE;
    const missing = fragments.find(
      (fragment) => findFragment(value, fragment, 0, executableRetention) < 0,
    );
    if (missing) throw failure(path, missing);
  };
  for (const [path, fragments] of NETWORK_SETTINGS_V2_SOURCE_CHECKS)
    requireFragments(path, sourceFor(path), fragments);
  for (const [path, start, end, fragments] of NETWORK_SETTINGS_V2_SCOPED_CHECKS) {
    const value = sourceFor(path);
    const first = findFragment(value, start, 0, true);
    const last =
      first < 0 ? -1 : findFragment(value, end, first + normalizedFragment(start).length, true);
    if (first < 0 || last < 0) throw failure(path, `Missing boundary: ${start}`);
    const scope = {
      source: value.source.slice(first, last),
      active: value.active.slice(first, last),
    };
    requireFragments(path, scope, fragments);
    if (path === RETENTION_FACADE && start === 'async update(') {
      // FLAG: The sole return must be unconditional delegation after authorization and parsing.
      // A nearby marker, quoted body or conditional legacy fallback cannot prove this contract.
      const body = scope.source.slice(scope.source.indexOf('{') + 1, -1);
      const expected = normalizedFragment(`
        await this.authorize(chatId, user);
        const parsed = updateMessageRetentionSchema.safeParse(body);
        if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
        const request = parsed.data;
        return this.requireEraser().update(chatId, user.userId, request, networkWrite);
      `);
      if (body !== expected) throw failure(path, 'Unconditional Lastik settings delegation');
    }
  }
  for (const [path, module, names] of NETWORK_SETTINGS_V2_RUNTIME_IMPORTS) {
    const value = sourceFor(path);
    const imports = [...value.source.matchAll(/\bimport\{([^}]*)\}from(['"])([^'"]+)\2/gu)].filter(
      (entry) => value.active[entry.index],
    );
    const runtime = imports.find((entry) => entry[3] === module)?.[1].split(',') ?? [];
    const missing = names.find((name) => !runtime.includes(name));
    if (missing) throw failure(path, `Missing runtime import: ${module} ${missing}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertNetworkSettingsV2Source(process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
