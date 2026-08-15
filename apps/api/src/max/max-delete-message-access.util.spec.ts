import { ChatEntityType } from '../prisma/prisma-client';
import {
  hasConfirmedDeleteMessageAccess,
  hasConfirmedEditMessageAccess,
  resolveDeleteMessageAccessFailure,
} from './max-delete-message-access.util';

describe('MAX delete message access', () => {
  it.each([
    {
      label: 'chat admin with write',
      entityType: ChatEntityType.CHAT,
      isAdmin: true,
      isOwner: false,
      permissions: ['read_all_messages', 'write'],
      expected: null,
    },
    {
      label: 'chat owner with legacy post-edit-delete',
      entityType: ChatEntityType.CHAT,
      isAdmin: false,
      isOwner: true,
      permissions: ['read_all_messages', 'post_edit_delete_message'],
      expected: null,
    },
    {
      label: 'chat admin with compatible can-write alias',
      entityType: ChatEntityType.CHAT,
      isAdmin: true,
      isOwner: false,
      permissions: ['can_write'],
      expected: null,
    },
    {
      label: 'chat admin with compatible plural post-edit-delete alias',
      entityType: ChatEntityType.CHAT,
      isAdmin: true,
      isOwner: false,
      permissions: ['can_post_edit_delete_messages'],
      expected: null,
    },
    {
      label: 'chat admin with channel delete only',
      entityType: ChatEntityType.CHAT,
      isAdmin: true,
      isOwner: false,
      permissions: ['read_all_messages', 'delete'],
      expected: 'missing_chat_delete_permission',
    },
    {
      label: 'channel admin with delete',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: true,
      isOwner: false,
      permissions: ['read_all_messages', 'delete'],
      expected: null,
    },
    {
      label: 'channel owner with legacy delete-message',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: false,
      isOwner: true,
      permissions: ['read_all_messages', 'delete_message'],
      expected: null,
    },
    {
      label: 'channel admin with compatible plural delete-message alias',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: true,
      isOwner: false,
      permissions: ['can_delete_messages'],
      expected: null,
    },
    {
      label: 'channel admin with chat write only',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: true,
      isOwner: false,
      permissions: ['read_all_messages', 'write'],
      expected: 'missing_channel_delete_permission',
    },
    {
      label: 'chat admin with channel delete alias only',
      entityType: ChatEntityType.CHAT,
      isAdmin: true,
      isOwner: false,
      permissions: ['can_delete_messages'],
      expected: 'missing_chat_delete_permission',
    },
    {
      label: 'channel admin with chat post-edit-delete alias only',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: true,
      isOwner: false,
      permissions: ['can_post_edit_delete_messages'],
      expected: 'missing_channel_delete_permission',
    },
    {
      label: 'channel admin with delete but without read-all',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: true,
      isOwner: false,
      permissions: ['delete'],
      expected: null,
    },
    {
      label: 'ordinary member with every permission',
      entityType: ChatEntityType.CHAT,
      isAdmin: false,
      isOwner: false,
      permissions: ['read_all_messages', 'write'],
      expected: 'not_admin_or_owner',
    },
  ])('$label', ({ entityType, isAdmin, isOwner, permissions, expected }) => {
    const snapshot = {
      checkedAt: '2026-05-09T10:04:00.000Z',
      isAdmin,
      isOwner,
      permissions,
    };

    expect(resolveDeleteMessageAccessFailure(snapshot, entityType)).toBe(expected);
    expect(hasConfirmedDeleteMessageAccess(snapshot, entityType)).toBe(expected === null);
  });

  it('classifies an absent snapshot separately', () => {
    expect(resolveDeleteMessageAccessFailure(null, ChatEntityType.CHAT)).toBe('snapshot_missing');
    expect(hasConfirmedDeleteMessageAccess(null, ChatEntityType.CHAT)).toBe(false);
  });

  it('fails closed when the entity type is unknown despite broad mutation permissions', () => {
    const snapshot = {
      checkedAt: '2026-08-15T10:00:00.000Z',
      isAdmin: true,
      isOwner: false,
      permissions: ['write', 'edit', 'delete'],
    };

    expect(resolveDeleteMessageAccessFailure(snapshot, null)).toBe('entity_type_unknown');
    expect(hasConfirmedDeleteMessageAccess(snapshot, null)).toBe(false);
    expect(hasConfirmedEditMessageAccess(snapshot, null)).toBe(false);
  });

  it.each([
    {
      label: 'chat admin with current write permission',
      entityType: ChatEntityType.CHAT,
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      expected: true,
    },
    {
      label: 'chat owner with legacy post-edit-delete permission',
      entityType: ChatEntityType.CHAT,
      isAdmin: false,
      isOwner: true,
      permissions: ['post_edit_delete_message'],
      expected: true,
    },
    {
      label: 'chat admin with compatible legacy alias',
      entityType: ChatEntityType.CHAT,
      isAdmin: true,
      isOwner: false,
      permissions: ['can_post_edit_delete_messages'],
      expected: true,
    },
    {
      label: 'chat admin with channel edit permission only',
      entityType: ChatEntityType.CHAT,
      isAdmin: true,
      isOwner: false,
      permissions: ['edit'],
      expected: false,
    },
    {
      label: 'channel admin with current edit permission',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: true,
      isOwner: false,
      permissions: ['edit'],
      expected: true,
    },
    {
      label: 'channel owner with legacy edit-message permission',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: false,
      isOwner: true,
      permissions: ['edit_message'],
      expected: true,
    },
    {
      label: 'channel admin with compatible plural edit-message alias',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: true,
      isOwner: false,
      permissions: ['can_edit_messages'],
      expected: true,
    },
    {
      label: 'channel admin with chat write permission only',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      expected: false,
    },
    {
      label: 'channel owner without an explicit edit permission',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: false,
      isOwner: true,
      permissions: [],
      expected: false,
    },
    {
      label: 'ordinary member with a valid entity permission',
      entityType: ChatEntityType.CHAT,
      isAdmin: false,
      isOwner: false,
      permissions: ['write'],
      expected: false,
    },
  ])(
    'resolves edit access for $label',
    ({ entityType, isAdmin, isOwner, permissions, expected }) => {
      expect(
        hasConfirmedEditMessageAccess(
          {
            checkedAt: '2026-08-15T10:00:00.000Z',
            isAdmin,
            isOwner,
            permissions,
          },
          entityType,
        ),
      ).toBe(expected);
    },
  );
});
