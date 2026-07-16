import { ChatEntityType } from '../prisma/prisma-client';
import {
  hasConfirmedDeleteMessageAccess,
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
      label: 'channel admin with chat write only',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: true,
      isOwner: false,
      permissions: ['read_all_messages', 'write'],
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
});
