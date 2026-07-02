import { z } from 'zod';
import { booleanQueryFlagSchema } from './dashboard-common.js';
import { membershipActivityPageSchema } from './membership-activity.js';

export const channelStatsRangeSchema = z.enum(['24h', '7d', '30d']);
export type ChannelStatsRange = z.infer<typeof channelStatsRangeSchema>;

export const channelStatsModeSchema = z.enum(['full', 'overview']);
export type ChannelStatsMode = z.infer<typeof channelStatsModeSchema>;

export const channelStatsQuerySchema = z.object({
  range: channelStatsRangeSchema.default('7d'),
  includeActivityPreview: booleanQueryFlagSchema.default(true),
  mode: channelStatsModeSchema.optional(),
});
export type ChannelStatsQuery = z.infer<typeof channelStatsQuerySchema>;

export const channelStatsBucketSchema = z.enum(['hour', 'day']);
export type ChannelStatsBucket = z.infer<typeof channelStatsBucketSchema>;

export const channelStatsReactionSchema = z.object({
  emoji: z.string().min(1),
  count: z.number().int().min(0),
});
export type ChannelStatsReaction = z.infer<typeof channelStatsReactionSchema>;

export const channelStatsSignalToneSchema = z.enum([
  'accent',
  'success',
  'warning',
  'danger',
  'neutral',
]);
export type ChannelStatsSignalTone = z.infer<typeof channelStatsSignalToneSchema>;

export const channelStatsMetricDeltaSchema = z.object({
  current: z.number().int(),
  previous: z.number().int(),
  absolute: z.number().int(),
  percent: z.number().nullable(),
});
export type ChannelStatsMetricDelta = z.infer<typeof channelStatsMetricDeltaSchema>;

export const channelStatsGraphMarkerSchema = z.object({
  code: z.string().min(1).max(64),
  type: z.enum(['post', 'peak', 'anomaly']),
  label: z.string().min(1).max(48),
  value: z.string().min(1).max(32),
  tone: channelStatsSignalToneSchema,
  at: z.string().datetime(),
});
export type ChannelStatsGraphMarker = z.infer<typeof channelStatsGraphMarkerSchema>;

export const channelStatsBestWindowSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  score: z.number().int().min(0),
  posts: z.number().int().min(0),
  averageViews: z.number().int().min(0),
  averageReactions: z.number().int().min(0),
});
export type ChannelStatsBestWindow = z.infer<typeof channelStatsBestWindowSchema>;

export const channelStatsTopPostSchema = z.object({
  messageId: z.string(),
  publishedAt: z.string().datetime(),
  url: z.string().trim().max(2_048).nullable(),
  previewUrl: z.string().trim().url().max(2_048).nullable().default(null),
  viewsDelta: z.number().int().min(0),
});
export type ChannelStatsTopPost = z.infer<typeof channelStatsTopPostSchema>;

export const channelStatsSummarySchema = z.object({
  subscribers: z.object({
    current: z.number().int().min(0).nullable(),
    todayDelta: z.number().int().nullable(),
    todayJoined: z.number().int().min(0).nullable().optional(),
    todayLeft: z.number().int().min(0).nullable().optional(),
    weekDelta: z.number().int().nullable(),
    sixteenDaysDelta: z.number().int().nullable(),
  }),
  views: z.object({
    perPost: z.number().int().min(0).nullable(),
    last24h: z.number().int().min(0).nullable(),
    last48h: z.number().int().min(0).nullable(),
    er24: z.number().nullable(),
  }),
  daily: z.array(
    z.object({
      date: z.string().min(1),
      subscribers: z.number().int().min(0).nullable(),
      delta: z.number().int().nullable(),
      joined: z.number().int().min(0).nullable().optional(),
      left: z.number().int().min(0).nullable().optional(),
    }),
  ),
});
export type ChannelStatsSummary = z.infer<typeof channelStatsSummarySchema>;

export const channelStatsResponseSchema = z.object({
  channel: z.object({
    id: z.string(),
    title: z.string(),
    participantsCount: z.number().int().min(0).nullable(),
    status: z.string().nullable(),
    isPublic: z.boolean().nullable(),
    link: z.string().trim().max(2_048).nullable(),
    lastEventAt: z.string().datetime().nullable(),
    avatarUrl: z.string().trim().url().nullable().optional(),
  }),
  period: z.object({
    range: channelStatsRangeSchema,
    from: z.string().datetime(),
    to: z.string().datetime(),
    bucket: channelStatsBucketSchema,
  }),
  official: z.object({
    audience: z.object({
      joined: z.number().int().min(0),
      left: z.number().int().min(0).nullable(),
      net: z.number().int().nullable(),
    }),
    content: z.object({
      posts: z.number().int().min(0),
      views: z.number().int().min(0),
      reactions: z.number().int().min(0),
      topReactions: z.array(channelStatsReactionSchema),
      topPosts: z.array(channelStatsTopPostSchema),
      lastPublishedAt: z.string().datetime().nullable(),
    }),
    series: z.object({
      participants: z.array(
        z.object({
          at: z.string().datetime(),
          participantsCount: z.number().int().min(0).nullable(),
        }),
      ),
      membership: z.array(
        z.object({
          at: z.string().datetime(),
          joined: z.number().int().min(0),
          left: z.number().int().min(0).nullable(),
        }),
      ),
      views: z.array(
        z.object({
          at: z.string().datetime(),
          posts: z.number().int().min(0),
          views: z.number().int().min(0),
        }),
      ),
    }),
  }),
  summary: channelStatsSummarySchema,
  secondary: z.object({
    postsWithButtons: z.number().int().min(0),
    comments: z.number().int().min(0),
    suggestions: z.number().int().min(0),
    commentAuthors: z.number().int().min(0),
    suggestionAuthors: z.number().int().min(0),
    suggestionsDelivered: z.number().int().min(0),
    suggestionsFailed: z.number().int().min(0),
    lastBotActivityAt: z.string().datetime().nullable(),
  }),
  meta: z.object({
    maxSnapshotAvailable: z.boolean(),
    viewsAvailable: z.boolean(),
    churnAvailable: z.boolean(),
    officialCoverageFrom: z.string().datetime().nullable(),
    refreshQueued: z.boolean().default(false),
  }),
  comparison: z.object({
    period: z.object({
      from: z.string().datetime(),
      to: z.string().datetime(),
    }),
    deltas: z.object({
      audienceNet: channelStatsMetricDeltaSchema,
      joined: channelStatsMetricDeltaSchema,
      left: channelStatsMetricDeltaSchema,
      posts: channelStatsMetricDeltaSchema,
      views: channelStatsMetricDeltaSchema,
      averageViewsPerPost: channelStatsMetricDeltaSchema,
      reactions: channelStatsMetricDeltaSchema,
    }),
    series: z
      .object({
        participants: z.array(
          z.object({
            at: z.string().datetime(),
            participantsCount: z.number().int().min(0).nullable(),
          }),
        ),
        membership: z.array(
          z.object({
            at: z.string().datetime(),
            joined: z.number().int().min(0),
            left: z.number().int().min(0).nullable(),
          }),
        ),
        views: z.array(
          z.object({
            at: z.string().datetime(),
            posts: z.number().int().min(0),
            views: z.number().int().min(0),
          }),
        ),
      })
      .optional(),
  }),
  signals: z.object({
    markers: z.array(channelStatsGraphMarkerSchema).max(8),
    bestWindows: z.array(channelStatsBestWindowSchema).max(3),
  }),
  activityFeed: membershipActivityPageSchema,
});
export type ChannelStatsResponse = z.infer<typeof channelStatsResponseSchema>;
