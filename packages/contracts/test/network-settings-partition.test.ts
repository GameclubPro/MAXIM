import { describe, expect, it } from 'vitest';
import * as compatibility from '../src/network-settings.js';
import * as read from '../src/network-settings-read.js';
import * as actions from '../src/network-settings-actions.js';
import * as metadata from '../src/network-settings-metadata.js';
import { managedEntityFavoriteTypeSchema } from '../src/managed-entity-favorite-type.js';
import {
  managedEntityFavoriteTypeSchema as compatibilityFavoriteTypeSchema,
  managedEntityHeaderSchema,
} from '../src/managed-entities.js';

const operationId = '55555555-5555-4555-8555-555555555555';
const requestId = '66666666-6666-4666-8666-666666666666';
const at = '2026-10-22T00:00:00.000Z';
const scope = {
  entityType: 'chat',
  target: { mode: 'selected', entityIds: ['one'] },
  section: 'limits',
};
const recipient = { entityId: 'one', title: 'First', revision: at };
const preview = {
  ...scope,
  operationId,
  compositionVersion: 'snapshot',
  recipients: [recipient],
  changes: [{ path: 'antiSpamEnabled', op: 'set', value: true }],
};
const metadataScope = {
  ...scope,
  compositionVersion: 'snapshot',
  requestId,
};
const witness = { revision: '3', observedAt: at, nextExpiryAt: null };
const target = { value: 'https://example.com', kind: 'WEB_EXACT' };

describe('focused network settings contract compatibility', () => {
  it('reexports the same canonical runtime bindings through the compatibility entry', () => {
    const focused = { ...read, ...actions, ...metadata };
    expect(Object.keys(compatibility).sort()).toEqual(Object.keys(focused).sort());
    for (const [name, schema] of Object.entries(focused)) {
      expect(compatibility[name as keyof typeof compatibility], name).toBe(schema);
    }
    expect(compatibilityFavoriteTypeSchema).toBe(managedEntityFavoriteTypeSchema);
    expect(read.networkSettingsTargetSchema.options[0].shape.favoriteType).toBe(
      managedEntityFavoriteTypeSchema,
    );
    expect(metadata.networkSettingsRequiredSubscriptionResolveResponseSchema.shape.channel).toBe(
      managedEntityHeaderSchema,
    );
  });

  it('shares the exact operation status schema while preserving all accepted status values', () => {
    const statuses = [
      'PREVIEWING',
      'PREPARED',
      'AUTHORIZING',
      'RUNNING',
      'COMPLETE',
      'PARTIAL',
      'FAILED',
    ];
    expect(actions.networkSettingsOperationResponseSchema.shape.status).toBe(
      read.networkSettingsOperationStatusSchema,
    );
    expect(read.networkSettingsOperationStatusSchema.options).toEqual(statuses);
    expect(actions.networkSettingsPreviewResponseSchema.shape.status.options).toEqual(statuses);
    for (const status of statuses) {
      expect(
        actions.networkSettingsOperationResponseSchema.parse({
          operationId,
          entityType: 'chat',
          section: 'limits',
          status,
          expiresAt: at,
          outcomes: [{ entityId: 'one', status: 'PENDING' }],
        }).status,
      ).toBe(status);
    }
    expect(read.networkSettingsOperationStatusSchema.safeParse('PENDING').success).toBe(false);
  });

  it('preserves explicit target selection, normalization and strict read boundaries', () => {
    expect(
      read.networkSettingsReadRequestSchema.parse({
        ...scope,
        target: { mode: 'selected', entityIds: [' one ', 'one', 'two'] },
      }).target,
    ).toEqual({ mode: 'selected', entityIds: ['one', 'two'] });
    expect(
      read.networkSettingsReadRequestSchema.safeParse({ ...scope, target: undefined }).success,
    ).toBe(false);
    expect(
      read.networkSettingsReadRequestSchema.safeParse({
        ...scope,
        target: { mode: 'selected', entityIds: [] },
      }).success,
    ).toBe(false);
    expect(
      read.networkSettingsReadRequestSchema.safeParse({ ...scope, unexpected: true }).success,
    ).toBe(false);
    expect(read.networkSettingsFieldSchema.parse({ kind: 'mixed' })).toEqual({ kind: 'mixed' });
    expect(read.networkSettingsFieldSchema.safeParse({ kind: 'mixed', value: true }).success).toBe(
      false,
    );
    expect(read.networkSettingsRecipientSchema.parse({ ...recipient, revision: 0 }).revision).toBe(
      0,
    );
  });

  it('preserves preview field and recipient fences after separating action schemas', () => {
    expect(actions.networkSettingsPreviewRequestSchema.parse(preview)).toEqual(preview);
    for (const invalid of [
      { ...preview, changes: [] },
      { ...preview, recipients: [recipient, recipient] },
      {
        ...preview,
        changes: [
          { path: 'botSpeech', op: 'set', value: {} },
          { path: 'botSpeech.text', op: 'set', value: 'Hello' },
        ],
      },
      { ...preview, changes: [{ path: 'reportsAliases', op: 'replace', value: 'one' }] },
      { ...preview, cursor: 'read-only-cursor' },
    ]) {
      expect(actions.networkSettingsPreviewRequestSchema.safeParse(invalid).success).toBe(false);
    }
    expect(
      actions.networkSettingsPreviewRequestSchema.parse({
        ...preview,
        changes: [{ path: 'reportsAliases', op: 'replace', value: ['one', 'two'] }],
      }).changes,
    ).toEqual([{ path: 'reportsAliases', op: 'replace', value: ['one', 'two'] }]);
  });

  it('preserves witnessed allowlist-only changes and rejects incompatible sections or missing witnesses', () => {
    const input = {
      ...preview,
      section: 'links',
      recipients: [{ ...recipient, navigationAllowlistWitness: witness }],
      changes: [],
      navigationAllowlist: { mode: 'edit', actions: [{ op: 'add', target, removeAfterAt: null }] },
    };
    expect(actions.networkSettingsPreviewRequestSchema.parse(input)).toEqual(input);
    for (const invalid of [
      { ...input, entityType: 'channel' },
      { ...input, section: 'limits' },
      { ...input, recipients: [recipient] },
    ]) {
      expect(actions.networkSettingsPreviewRequestSchema.safeParse(invalid).success).toBe(false);
    }
    expect(
      read.networkNavigationAllowlistIntentSchema.parse({ mode: 'replace', entries: [] }),
    ).toEqual({ mode: 'replace', entries: [] });
    expect(
      read.networkNavigationAllowlistIntentSchema.safeParse({
        mode: 'edit',
        actions: Array.from({ length: read.NETWORK_ALLOWLIST_ACTION_LIMIT + 1 }, () => ({
          op: 'remove',
          target,
        })),
      }).success,
    ).toBe(false);
  });

  it('keeps metadata and allowlist read scopes strict without introducing request defaults', () => {
    expect(read.networkSettingsMetadataScopeSchema.parse(metadataScope)).toEqual(metadataScope);
    expect(
      read.networkSettingsMetadataScopeSchema.safeParse({ ...metadataScope, cursor: 'old' })
        .success,
    ).toBe(false);
    expect(
      read.networkNavigationAllowlistReadRequestSchema.parse({ ...metadataScope, entityId: 'one' }),
    ).toEqual({ ...metadataScope, entityId: 'one' });
    const response = {
      entityId: 'one',
      compositionVersion: 'snapshot',
      witness,
      entries: [{ ...target, removeAfterAt: null }],
      totalEntries: 1,
      complete: true,
      nextCursor: null,
    };
    expect(read.networkNavigationAllowlistReadResponseSchema.parse(response)).toEqual(response);
    expect(
      read.networkNavigationAllowlistReadResponseSchema.safeParse({ ...response, extra: true })
        .success,
    ).toBe(false);
  });

  it('keeps required-subscription header defaults and explicit metadata request validation', () => {
    expect(
      metadata.networkSettingsRequiredSubscriptionResolveRequestSchema.parse({
        ...metadataScope,
        value: ' https://max.ru/example ',
      }).value,
    ).toBe('https://max.ru/example');
    const resolved = metadata.networkSettingsRequiredSubscriptionResolveResponseSchema.parse({
      requestId,
      compositionVersion: 'snapshot',
      channel: {
        id: 'channel',
        title: 'Channel',
        entityType: 'channel',
        link: null,
        participantsCount: null,
      },
    });
    expect(resolved.channel).toMatchObject({
      primaryBotId: null,
      assignedBots: [],
      sharedMode: 'owned',
      viewerAccess: { state: 'checking', reason: null, checkedAt: null, canEdit: false },
    });
    expect(metadata.networkSettingsAdminContactsReadRequestSchema.parse(metadataScope)).toEqual(
      metadataScope,
    );
    expect(
      metadata.networkSettingsAdminContactsReadRequestSchema.safeParse({
        ...metadataScope,
        cursor: 'not-a-uuid',
      }).success,
    ).toBe(false);
    expect(
      metadata.networkSettingsAdminContactsResolveRequestSchema.safeParse({
        ...metadataScope,
        cursor: requestId,
        sourceEntityId: 'one',
      }).success,
    ).toBe(false);
    expect(
      metadata.networkSettingsAdminContactResolveResponseSchema.safeParse({
        requestId,
        compositionVersion: 'snapshot',
        contact: {
          userId: 'user',
          displayName: null,
          url: 'https://max.ru/user',
          sources: ['one'],
        },
        extra: true,
      }).success,
    ).toBe(false);
  });
});
