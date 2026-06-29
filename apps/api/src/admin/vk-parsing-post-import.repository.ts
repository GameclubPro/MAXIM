import { VK_PARSING_MAX_LINKS, VK_PARSING_MAX_PHOTOS, VK_PARSING_MAX_VIDEOS } from '@maxim/contracts';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';

export type ExistingVkPostImportState = {
  id: string;
  vkOwnerId: number;
  vkPostId: number;
  status: string;
  contentHash: string;
  publishedContentHash: string | null;
};

export type VkParsingPostImportSource = {
  id: string;
  chatId: string;
  wallOwnerId: number;
};

export type VkParsingNormalizedPostForImport = {
  vkOwnerId: number;
  vkPostId: number;
  vkPublishedAt: Date | null;
  text: string;
  url: string;
  photoUrls: string[];
  videoUrls: string[];
  linkUrls: string[];
  attachments: unknown[];
  attachmentTypes: string[];
  unsupportedAttachments: unknown[];
  hasUnsupportedAttachments: boolean;
  isAdvertising: boolean;
  advertisingMarkers: string[];
  raw: Record<string, unknown>;
  contentHash: string;
};

export type PreparedVkPostImport = {
  post: VkParsingNormalizedPostForImport;
  status: string;
};

export type VkMissingPostSpotCheck = (
  posts: Array<{ vkOwnerId: number; vkPostId: number }>,
) => Promise<Set<string> | null>;

const VK_POST_STATUS_NEW = 'NEW';
const VK_POST_STATUS_FAILED = 'FAILED';
const VK_POST_STATUS_CHANGED_AFTER_PUBLISH = 'CHANGED_AFTER_PUBLISH';
const VK_POST_STATUS_UNAVAILABLE = 'UNAVAILABLE';
const VK_POST_IMPORT_CHUNK_SIZE = 50;

@Injectable()
export class VkParsingPostImportRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findExistingPosts(
    source: VkParsingPostImportSource,
    posts: VkParsingNormalizedPostForImport[],
  ): Promise<ExistingVkPostImportState[]> {
    return posts.length
      ? this.prisma.vkParsingPost.findMany({
          where: {
            chatId: source.chatId,
            vkOwnerId: source.wallOwnerId,
            vkPostId: { in: posts.map((post) => post.vkPostId) },
          },
          select: {
            id: true,
            vkOwnerId: true,
            vkPostId: true,
            status: true,
            contentHash: true,
            publishedContentHash: true,
          },
        })
      : [];
  }

  async persistImportedPosts(
    source: VkParsingPostImportSource,
    posts: PreparedVkPostImport[],
    seenAt: Date,
  ): Promise<void> {
    for (const chunk of this.chunkItems(posts, VK_POST_IMPORT_CHUNK_SIZE)) {
      await this.persistImportedPostsChunk(source, chunk, seenAt);
    }
  }

  async markMissingPostsUnavailable(
    source: VkParsingPostImportSource,
    posts: VkParsingNormalizedPostForImport[],
    seenAt: Date,
    params: {
      missingConfirmationThreshold: number;
      spotCheckMissingPosts: VkMissingPostSpotCheck;
    },
  ): Promise<void> {
    if (posts.length === 0) {
      return;
    }

    const oldestFetchedAt = posts.reduce<Date | null>((oldest, post) => {
      if (!post.vkPublishedAt) {
        return oldest;
      }
      return !oldest || post.vkPublishedAt.getTime() < oldest.getTime()
        ? post.vkPublishedAt
        : oldest;
    }, null);
    if (!oldestFetchedAt) {
      return;
    }

    const candidates = await this.prisma.vkParsingPost.findMany({
      where: {
        sourceId: source.id,
        vkPublishedAt: { gte: oldestFetchedAt },
        vkPostId: { notIn: posts.map((post) => post.vkPostId) },
        status: {
          in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED, VK_POST_STATUS_CHANGED_AFTER_PUBLISH],
        },
      },
      select: {
        id: true,
        vkOwnerId: true,
        vkPostId: true,
        missingSeenCount: true,
      },
    });
    if (candidates.length === 0) {
      return;
    }

    const belowThreshold = candidates.filter(
      (post) => post.missingSeenCount + 1 < params.missingConfirmationThreshold,
    );
    if (belowThreshold.length > 0) {
      await this.prisma.vkParsingPost.updateMany({
        where: { id: { in: belowThreshold.map((post) => post.id) } },
        data: {
          missingSeenCount: { increment: 1 },
          missingSinceAt: seenAt,
          lastAvailabilityCheckedAt: seenAt,
        },
      });
    }

    const thresholdCandidates = candidates.filter(
      (post) => post.missingSeenCount + 1 >= params.missingConfirmationThreshold,
    );
    if (thresholdCandidates.length === 0) {
      return;
    }

    const foundPostKeys = await params.spotCheckMissingPosts(thresholdCandidates);
    const updateOperations = thresholdCandidates.map((post) => {
      const postKey = this.buildPostKey(post.vkOwnerId, post.vkPostId);
      if (foundPostKeys?.has(postKey)) {
        return this.prisma.vkParsingPost.update({
          where: { id: post.id },
          data: {
            missingSeenCount: 0,
            missingSinceAt: null,
            lastAvailabilityCheckedAt: seenAt,
          },
        });
      }

      return this.prisma.vkParsingPost.update({
        where: { id: post.id },
        data: {
          status: foundPostKeys === null ? undefined : VK_POST_STATUS_UNAVAILABLE,
          missingSeenCount: { increment: 1 },
          missingSinceAt: seenAt,
          lastAvailabilityCheckedAt: seenAt,
          unavailableAt: foundPostKeys === null ? undefined : seenAt,
          publishQueuedAt: foundPostKeys === null ? undefined : null,
          publishLockedAt: foundPostKeys === null ? undefined : null,
          publishIdempotencyKey: foundPostKeys === null ? undefined : null,
          publishReason: foundPostKeys === null ? undefined : null,
        },
      });
    });

    for (const chunk of this.chunkItems(updateOperations, VK_POST_IMPORT_CHUNK_SIZE)) {
      await this.prisma.$transaction(chunk);
    }
  }

  private async persistImportedPostsChunk(
    source: VkParsingPostImportSource,
    posts: PreparedVkPostImport[],
    seenAt: Date,
  ): Promise<void> {
    if (posts.length === 0) {
      return;
    }

    const rows = posts.map(
      ({ post, status }) =>
        Prisma.sql`(
        ${this.createDatabaseId('vkpost')},
        ${source.id},
        ${source.chatId},
        ${post.vkOwnerId},
        ${post.vkPostId},
        ${post.vkPublishedAt},
        ${post.text},
        ${post.url},
        ${this.toJsonbSql(post.photoUrls.slice(0, VK_PARSING_MAX_PHOTOS))},
        ${this.toJsonbSql(post.videoUrls.slice(0, VK_PARSING_MAX_VIDEOS))},
        ${this.toJsonbSql(post.linkUrls.slice(0, VK_PARSING_MAX_LINKS))},
        ${this.toJsonbSql(post.attachments)},
        ${this.toJsonbSql(post.attachmentTypes)},
        ${this.toJsonbSql(post.unsupportedAttachments)},
        ${post.hasUnsupportedAttachments},
        ${post.isAdvertising},
        ${this.toJsonbSql(post.advertisingMarkers)},
        ${this.toJsonbSql(post.raw)},
        ${post.contentHash},
        ${status},
        ${seenAt},
        ${seenAt},
        ${seenAt}
      )`,
    );

    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO "vk_parsing_posts" (
        "id",
        "source_id",
        "chat_id",
        "vk_owner_id",
        "vk_post_id",
        "vk_published_at",
        "text",
        "url",
        "photo_urls",
        "video_urls",
        "link_urls",
        "attachments",
        "attachment_types",
        "unsupported_attachments",
        "has_unsupported_attachments",
        "is_advertising",
        "advertising_markers",
        "raw",
        "content_hash",
        "status",
        "last_seen_at",
        "last_availability_checked_at",
        "updated_at"
      )
      VALUES ${Prisma.join(rows)}
      ON CONFLICT ("chat_id", "vk_owner_id", "vk_post_id")
      DO UPDATE SET
        "source_id" = EXCLUDED."source_id",
        "vk_published_at" = EXCLUDED."vk_published_at",
        "text" = EXCLUDED."text",
        "url" = EXCLUDED."url",
        "photo_urls" = EXCLUDED."photo_urls",
        "video_urls" = EXCLUDED."video_urls",
        "link_urls" = EXCLUDED."link_urls",
        "attachments" = EXCLUDED."attachments",
        "attachment_types" = EXCLUDED."attachment_types",
        "unsupported_attachments" = EXCLUDED."unsupported_attachments",
        "has_unsupported_attachments" = EXCLUDED."has_unsupported_attachments",
        "is_advertising" = EXCLUDED."is_advertising",
        "advertising_markers" = EXCLUDED."advertising_markers",
        "raw" = EXCLUDED."raw",
        "content_hash" = EXCLUDED."content_hash",
        "status" = EXCLUDED."status",
        "last_seen_at" = EXCLUDED."last_seen_at",
        "missing_since_at" = NULL,
        "missing_seen_count" = 0,
        "last_availability_checked_at" = EXCLUDED."last_availability_checked_at",
        "unavailable_at" = NULL,
        "skipped_at" = CASE
          WHEN EXCLUDED."status" = ${VK_POST_STATUS_NEW} THEN NULL
          ELSE "vk_parsing_posts"."skipped_at"
        END,
        "skip_reason" = CASE
          WHEN EXCLUDED."status" = ${VK_POST_STATUS_NEW} THEN NULL
          ELSE "vk_parsing_posts"."skip_reason"
        END,
        "auto_publish_error" = CASE
          WHEN EXCLUDED."status" = ${VK_POST_STATUS_NEW} THEN NULL
          ELSE "vk_parsing_posts"."auto_publish_error"
        END,
        "last_error" = CASE
          WHEN EXCLUDED."status" = ${VK_POST_STATUS_NEW} THEN NULL
          ELSE "vk_parsing_posts"."last_error"
        END,
        "updated_at" = CURRENT_TIMESTAMP
    `);
  }

  private buildPostKey(ownerId: number, postId: number): string {
    return `${ownerId}:${postId}`;
  }

  private toJsonbSql(value: unknown): Prisma.Sql {
    return Prisma.sql`CAST(${JSON.stringify(value ?? null)} AS jsonb)`;
  }

  private createDatabaseId(prefix: string): string {
    return `${prefix}_${randomUUID().replace(/-/gu, '')}`;
  }

  private chunkItems<T>(items: readonly T[], size: number): T[][] {
    const chunkSize = Math.max(1, Math.trunc(size));
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += chunkSize) {
      chunks.push(items.slice(index, index + chunkSize));
    }
    return chunks;
  }
}
