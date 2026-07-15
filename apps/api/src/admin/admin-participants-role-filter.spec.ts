import { chatParticipantsQuerySchema } from '@maxim/contracts';
import { matchesChatParticipantRoleFilter } from './admin-participants-runtime';

describe('participant role filters', () => {
  const owner = { role: 'owner', isBot: false } as const;
  const admin = { role: 'admin', isBot: false } as const;
  const member = { role: 'member', isBot: false } as const;
  const bot = { role: 'admin', isBot: true } as const;

  it('normalizes the default filter and accepts supported values', () => {
    expect(chatParticipantsQuerySchema.parse({}).roleFilter).toBe('all');
    expect(chatParticipantsQuerySchema.parse({ roleFilter: 'admins' }).roleFilter).toBe('admins');
    expect(chatParticipantsQuerySchema.safeParse({ roleFilter: 'unknown' }).success).toBe(false);
  });

  it('keeps bots separate from human admins and members', () => {
    expect(matchesChatParticipantRoleFilter(owner, 'admins')).toBe(true);
    expect(matchesChatParticipantRoleFilter(admin, 'admins')).toBe(true);
    expect(matchesChatParticipantRoleFilter(bot, 'admins')).toBe(false);
    expect(matchesChatParticipantRoleFilter(member, 'members')).toBe(true);
    expect(matchesChatParticipantRoleFilter(bot, 'members')).toBe(false);
    expect(matchesChatParticipantRoleFilter(bot, 'bots')).toBe(true);
    expect(matchesChatParticipantRoleFilter(member, 'bots')).toBe(false);
  });
});
