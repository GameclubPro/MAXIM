import { z } from 'zod';
import { logsDashboardRangeSchema } from './dashboard-common.js';

export const membershipActivityRangeSchema = logsDashboardRangeSchema;
export type MembershipActivityRange = z.infer<typeof membershipActivityRangeSchema>;

export const membershipActivityFilterSchema = z.enum(['all', 'joined', 'left']);
export type MembershipActivityFilter = z.infer<typeof membershipActivityFilterSchema>;

export const membershipActivityItemSchema = z.object({
  id: z.string(),
  type: z.enum(['joined', 'left']),
  userId: z.string(),
  userDisplayName: z.string().min(1),
  avatarUrl: z.string().trim().url().nullable().default(null),
  profileUrl: z.string().trim().url().nullable().default(null),
  profileHandoffUrl: z.string().trim().url().nullable().default(null),
  createdAt: z.string().datetime(),
});
export type MembershipActivityItem = z.infer<typeof membershipActivityItemSchema>;

export const membershipActivityPageSchema = z.object({
  items: z.array(membershipActivityItemSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().trim().min(1).nullable(),
});
export type MembershipActivityPage = z.infer<typeof membershipActivityPageSchema>;

export const membershipActivityQuerySchema = z.object({
  range: membershipActivityRangeSchema.default('7d'),
  filter: membershipActivityFilterSchema.default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).optional(),
});
export type MembershipActivityQuery = z.infer<typeof membershipActivityQuerySchema>;
