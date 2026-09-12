import type { ChatParticipantsQuery } from '@maxim/contracts';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { MaxChatMembersPage, MaxChatRosterMember } from '../max/max-client.service';

const cursorSchema = z.object({
  v: z.literal('activity-1'),
  scope: z.string(),
  marker: z.string().max(300).nullable(),
  offset: z.number().int().min(0).max(100),
  asOf: z.number().int().positive(),
});

export function matchesParticipantActivity(
  member: Pick<MaxChatRosterMember, 'lastMaxActivityAt' | 'isBot'>,
  filter: ChatParticipantsQuery['activityFilter'],
  asOf: number,
): boolean {
  if (!filter || filter === 'all') return true;
  const at = member.lastMaxActivityAt ? Date.parse(member.lastMaxActivityAt) : NaN;
  const known = Number.isFinite(at) && at > 0;
  if (filter === 'unknown') return !known;
  if (!known) return false;
  const days = Number(filter.slice(0, -1));
  return asOf - at >= days * 86_400_000;
}

export async function scanParticipantActivityPage(params: {
  chatId: string;
  userId: string;
  query: ChatParticipantsQuery;
  matches: (member: MaxChatRosterMember) => boolean;
  load: (marker: string | null) => Promise<MaxChatMembersPage>;
  maxPages: number;
  now?: number;
}): Promise<MaxChatMembersPage> {
  const { query } = params;
  const now = params.now ?? Date.now();
  const scope = JSON.stringify([
    params.chatId,
    params.userId,
    query.search ?? '',
    query.roleFilter,
    query.activityFilter,
  ]);
  let cursor = {
    v: 'activity-1' as const,
    scope,
    marker: null as string | null,
    offset: 0,
    asOf: now,
  };
  if (query.cursor) {
    try {
      if (query.cursor.length > 2000) throw new Error('Oversized cursor');
      cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')),
      );
      if (cursor.scope !== scope || cursor.asOf > now || now - cursor.asOf > 30 * 60_000)
        throw new Error('Expired or mismatched cursor');
    } catch {
      throw new BadRequestException('Список активности изменился. Обновите участников.');
    }
  }
  const items: MaxChatRosterMember[] = [];
  const markers = new Set<string | null>();
  const next = (marker: string | null, offset: number): MaxChatMembersPage => ({
    items,
    nextMarker: Buffer.from(JSON.stringify({ ...cursor, marker, offset })).toString('base64url'),
  });
  for (let pageIndex = 0; pageIndex < params.maxPages; pageIndex += 1) {
    if (markers.has(cursor.marker))
      throw new BadRequestException('MAX повторил страницу участников. Обновите список.');
    markers.add(cursor.marker);
    const page = await params.load(cursor.marker);
    if (page.nextMarker && (page.nextMarker === cursor.marker || markers.has(page.nextMarker)))
      throw new BadRequestException('MAX повторил страницу участников. Обновите список.');
    // FLAG: Continuation is a raw roster offset, not an offset into a changing filtered subset.
    for (let index = cursor.offset; index < page.items.length; index += 1) {
      if (items.length >= query.limit) return next(cursor.marker, index);
      const member = page.items[index]!;
      if (member.isBot && query.roleFilter !== 'bots') continue;
      if (
        params.matches(member) &&
        matchesParticipantActivity(member, query.activityFilter, cursor.asOf)
      )
        items.push(member);
    }
    if (!page.nextMarker) return { items, nextMarker: null };
    cursor = { ...cursor, marker: page.nextMarker, offset: 0 };
    if (items.length >= query.limit) return next(cursor.marker, 0);
  }
  return next(cursor.marker, 0);
}
