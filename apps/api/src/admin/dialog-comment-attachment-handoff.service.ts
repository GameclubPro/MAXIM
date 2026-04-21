import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import {
  MAX_CHANNEL_DIALOG_ATTACHMENTS,
  MAX_CHANNEL_DIALOG_COMMENT_FILES,
  channelDialogAttachmentHandoffStateSchema,
  type ChannelDialogAttachmentHandoffState,
  type ManagedEntityType,
} from '@maxim/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { RedisCounterService } from '../moderation/redis-counter.service';

const DIALOG_COMMENT_ATTACHMENT_HANDOFF_TTL_SEC = 6 * 60 * 60;

type DialogCommentAttachmentHandoffContext = {
  chatId: string;
  entityType: ManagedEntityType;
  token: string;
};

export type DialogCommentAttachmentHandoffStoredAttachment = {
  id: string;
  kind: 'image' | 'file';
  payload: Record<string, unknown>;
  mimeType?: string | null;
  fileName?: string | null;
  previewBase64?: string | null;
  width?: number | null;
  height?: number | null;
};

export type DialogCommentAttachmentHandoffAppendInput = Omit<
  DialogCommentAttachmentHandoffStoredAttachment,
  'id'
>;

type DialogCommentAttachmentHandoffDraft = {
  version: 1;
  chatId: string;
  entityType: ManagedEntityType;
  token: string;
  updatedAt: string;
  attachments: DialogCommentAttachmentHandoffStoredAttachment[];
};

@Injectable()
export class DialogCommentAttachmentHandoffService {
  private readonly memoryDrafts = new Map<
    string,
    { expiresAt: number; draft: DialogCommentAttachmentHandoffDraft }
  >();

  constructor(@Optional() private readonly redisCounter?: RedisCounterService) {}

  async appendAttachments(
    userId: string,
    context: DialogCommentAttachmentHandoffContext,
    attachments: DialogCommentAttachmentHandoffAppendInput[],
  ): Promise<ChannelDialogAttachmentHandoffState> {
    const normalizedInputs = attachments
      .map((attachment) => this.normalizeAppendInput(attachment))
      .filter(
        (
          attachment,
        ): attachment is DialogCommentAttachmentHandoffAppendInput & { payload: Record<string, unknown> } =>
          attachment !== null,
      );

    if (normalizedInputs.length === 0) {
      throw new BadRequestException('Добавьте фото или файл.');
    }

    const draft = await this.loadDraft(userId, context);
    const merged = [
      ...draft.attachments,
      ...normalizedInputs.map((attachment) => ({
        ...attachment,
        id: randomUUID(),
      })),
    ];

    if (merged.length > MAX_CHANNEL_DIALOG_ATTACHMENTS) {
      throw new BadRequestException(
        `Можно добавить до ${MAX_CHANNEL_DIALOG_ATTACHMENTS} вложений.`,
      );
    }

    const fileCount = merged.filter((attachment) => attachment.kind === 'file').length;
    if (fileCount > MAX_CHANNEL_DIALOG_COMMENT_FILES) {
      throw new BadRequestException(
        `Можно прикрепить до ${MAX_CHANNEL_DIALOG_COMMENT_FILES} файлов.`,
      );
    }

    const nextDraft = this.createDraft(context, merged);
    await this.saveDraft(userId, context, nextDraft);
    return this.buildState(nextDraft);
  }

  async getState(
    userId: string,
    context: DialogCommentAttachmentHandoffContext,
  ): Promise<ChannelDialogAttachmentHandoffState> {
    return this.buildState(await this.loadDraft(userId, context));
  }

  async resolveAttachments(
    userId: string,
    context: DialogCommentAttachmentHandoffContext,
    attachmentIds: string[],
  ): Promise<DialogCommentAttachmentHandoffStoredAttachment[]> {
    const normalizedIds = attachmentIds.map((item) => item.trim()).filter(Boolean);
    if (normalizedIds.length === 0) {
      return [];
    }

    const draft = await this.loadDraft(userId, context);
    const storedById = new Map(
      draft.attachments.map((attachment) => [attachment.id, attachment] as const),
    );

    const resolved = normalizedIds.map((attachmentId) => storedById.get(attachmentId) ?? null);
    if (resolved.some((attachment) => attachment === null)) {
      throw new BadRequestException('Часть вложений уже недоступна. Добавьте их заново.');
    }

    const fileCount = resolved.filter((attachment) => attachment?.kind === 'file').length;
    if (fileCount > MAX_CHANNEL_DIALOG_COMMENT_FILES) {
      throw new BadRequestException(
        `Можно прикрепить до ${MAX_CHANNEL_DIALOG_COMMENT_FILES} файлов.`,
      );
    }

    return resolved as DialogCommentAttachmentHandoffStoredAttachment[];
  }

  async removeAttachments(
    userId: string,
    context: DialogCommentAttachmentHandoffContext,
    attachmentIds: string[],
  ): Promise<void> {
    const normalizedIds = new Set(attachmentIds.map((item) => item.trim()).filter(Boolean));
    if (normalizedIds.size === 0) {
      return;
    }

    const draft = await this.loadDraft(userId, context);
    const nextDraft = this.createDraft(
      context,
      draft.attachments.filter((attachment) => !normalizedIds.has(attachment.id)),
    );
    await this.saveDraft(userId, context, nextDraft);
  }

  async clear(userId: string, context: DialogCommentAttachmentHandoffContext): Promise<void> {
    await this.saveDraft(userId, context, this.createDraft(context, []));
  }

  private async loadDraft(
    userId: string,
    context: DialogCommentAttachmentHandoffContext,
  ): Promise<DialogCommentAttachmentHandoffDraft> {
    const key = this.buildKey(userId, context);
    const normalizedContext = this.normalizeContext(context);

    if (this.redisCounter) {
      const raw = await this.redisCounter.getString(key);
      if (raw) {
        try {
          return this.normalizeDraft(JSON.parse(raw), normalizedContext);
        } catch {
          return this.createDraft(normalizedContext, []);
        }
      }
    }

    const memory = this.memoryDrafts.get(key);
    if (memory && memory.expiresAt > Date.now()) {
      return this.normalizeDraft(memory.draft, normalizedContext);
    }

    return this.createDraft(normalizedContext, []);
  }

  private async saveDraft(
    userId: string,
    context: DialogCommentAttachmentHandoffContext,
    draft: DialogCommentAttachmentHandoffDraft,
  ): Promise<void> {
    const normalizedContext = this.normalizeContext(context);
    const normalizedDraft = this.normalizeDraft(draft, normalizedContext);
    const key = this.buildKey(userId, normalizedContext);

    if (this.redisCounter) {
      await this.redisCounter.setStringWithTtl(
        key,
        JSON.stringify(normalizedDraft),
        DIALOG_COMMENT_ATTACHMENT_HANDOFF_TTL_SEC,
      );
      return;
    }

    this.memoryDrafts.set(key, {
      expiresAt: Date.now() + DIALOG_COMMENT_ATTACHMENT_HANDOFF_TTL_SEC * 1_000,
      draft: normalizedDraft,
    });
  }

  private buildState(
    draft: DialogCommentAttachmentHandoffDraft,
  ): ChannelDialogAttachmentHandoffState {
    return channelDialogAttachmentHandoffStateSchema.parse({
      attachments: draft.attachments
        .map((attachment) => this.mapStoredAttachment(attachment))
        .filter((attachment): attachment is NonNullable<typeof attachment> => attachment !== null),
    });
  }

  private mapStoredAttachment(
    attachment: DialogCommentAttachmentHandoffStoredAttachment,
  ): ChannelDialogAttachmentHandoffState['attachments'][number] | null {
    if (!attachment.payload || Object.keys(attachment.payload).length === 0) {
      return null;
    }

    const payload = attachment.payload;
    const fileName =
      this.readTrimmedString(
        attachment.fileName ??
          payload.file_name ??
          payload.fileName ??
          payload.filename ??
          payload.name,
      ) ?? null;
    const mimeType =
      this.readTrimmedString(attachment.mimeType ?? payload.mime_type ?? payload.mimeType) ?? null;
    const width = this.toSafeInteger(attachment.width ?? payload.width ?? payload.w);
    const height = this.toSafeInteger(attachment.height ?? payload.height ?? payload.h);
    const size = this.toSafeInteger(payload.size);
    const url = this.readTrimmedString(payload.url) ?? null;
    const previewBase64 = this.readTrimmedString(attachment.previewBase64 ?? payload.previewBase64);
    const previewUrl =
      url ||
      (attachment.kind === 'image' &&
      previewBase64 &&
      this.canBuildImagePreview(mimeType)
        ? `data:${mimeType};base64,${previewBase64}`
        : null);

    return {
      id: attachment.id,
      kind: attachment.kind,
      url,
      previewUrl,
      fileName,
      mimeType,
      size: typeof size === 'number' && size > 0 ? size : null,
      width: typeof width === 'number' && width > 0 ? width : null,
      height: typeof height === 'number' && height > 0 ? height : null,
    };
  }

  private normalizeAppendInput(
    input: DialogCommentAttachmentHandoffAppendInput,
  ): (DialogCommentAttachmentHandoffAppendInput & { payload: Record<string, unknown> }) | null {
    const kind = input.kind === 'image' ? 'image' : input.kind === 'file' ? 'file' : null;
    if (!kind || !input.payload || Object.keys(input.payload).length === 0) {
      return null;
    }

    return {
      kind,
      payload: input.payload,
      mimeType: this.readTrimmedString(input.mimeType),
      fileName: this.readTrimmedString(input.fileName),
      previewBase64: this.readTrimmedString(input.previewBase64),
      width: this.toSafeInteger(input.width),
      height: this.toSafeInteger(input.height),
    };
  }

  private createDraft(
    context: DialogCommentAttachmentHandoffContext,
    attachments: DialogCommentAttachmentHandoffStoredAttachment[],
  ): DialogCommentAttachmentHandoffDraft {
    const normalizedContext = this.normalizeContext(context);
    return {
      version: 1,
      chatId: normalizedContext.chatId,
      entityType: normalizedContext.entityType,
      token: normalizedContext.token,
      updatedAt: new Date().toISOString(),
      attachments: attachments.slice(0, MAX_CHANNEL_DIALOG_ATTACHMENTS).map((attachment) => ({
        id: attachment.id.trim(),
        kind: attachment.kind,
        payload: { ...attachment.payload },
        mimeType: this.readTrimmedString(attachment.mimeType),
        fileName: this.readTrimmedString(attachment.fileName),
        previewBase64: this.readTrimmedString(attachment.previewBase64),
        width: this.toSafeInteger(attachment.width),
        height: this.toSafeInteger(attachment.height),
      })),
    };
  }

  private normalizeDraft(
    raw: unknown,
    context: DialogCommentAttachmentHandoffContext,
  ): DialogCommentAttachmentHandoffDraft {
    if (!raw || typeof raw !== 'object') {
      return this.createDraft(context, []);
    }

    const row = raw as Partial<DialogCommentAttachmentHandoffDraft> & {
      attachments?: unknown;
      token?: unknown;
      chatId?: unknown;
      entityType?: unknown;
      updatedAt?: unknown;
    };

    const normalizedAttachments = Array.isArray(row.attachments)
      ? row.attachments
          .map((attachment) => this.normalizeStoredAttachment(attachment))
          .filter(
            (
              attachment,
            ): attachment is DialogCommentAttachmentHandoffStoredAttachment => attachment !== null,
          )
      : [];

    return {
      version: 1,
      chatId: typeof row.chatId === 'string' && row.chatId.trim() ? row.chatId.trim() : context.chatId,
      entityType: row.entityType === 'channel' ? 'channel' : row.entityType === 'chat' ? 'chat' : context.entityType,
      token: typeof row.token === 'string' && row.token.trim() ? row.token.trim() : context.token,
      updatedAt:
        typeof row.updatedAt === 'string' && row.updatedAt.trim()
          ? row.updatedAt.trim()
          : new Date().toISOString(),
      attachments: normalizedAttachments.slice(0, MAX_CHANNEL_DIALOG_ATTACHMENTS),
    };
  }

  private normalizeStoredAttachment(
    raw: unknown,
  ): DialogCommentAttachmentHandoffStoredAttachment | null {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const row = raw as Partial<DialogCommentAttachmentHandoffStoredAttachment> & {
      payload?: unknown;
    };
    const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : null;
    const kind = row.kind === 'image' ? 'image' : row.kind === 'file' ? 'file' : null;
    const payload =
      row.payload && typeof row.payload === 'object'
        ? ({ ...(row.payload as Record<string, unknown>) } as Record<string, unknown>)
        : null;
    if (!id || !kind || !payload || Object.keys(payload).length === 0) {
      return null;
    }

    return {
      id,
      kind,
      payload,
      mimeType: this.readTrimmedString(row.mimeType),
      fileName: this.readTrimmedString(row.fileName),
      previewBase64: this.readTrimmedString(row.previewBase64),
      width: this.toSafeInteger(row.width),
      height: this.toSafeInteger(row.height),
    };
  }

  private normalizeContext(
    context: DialogCommentAttachmentHandoffContext,
  ): DialogCommentAttachmentHandoffContext {
    const chatId = context.chatId.trim();
    const token = context.token.trim();
    const entityType = context.entityType === 'channel' ? 'channel' : 'chat';
    if (!chatId || !token) {
      throw new BadRequestException('Комментарий больше недоступен. Откройте его заново.');
    }

    return {
      chatId,
      entityType,
      token,
    };
  }

  private buildKey(userId: string, context: DialogCommentAttachmentHandoffContext): string {
    const normalizedUserId = userId.trim();
    const normalizedContext = this.normalizeContext(context);
    const tokenHash = createHash('sha256').update(normalizedContext.token).digest('hex').slice(0, 24);
    return [
      'dialog-comment-attachment-handoff',
      'v1',
      normalizedUserId,
      normalizedContext.entityType,
      normalizedContext.chatId,
      tokenHash,
    ].join(':');
  }

  private readTrimmedString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private toSafeInteger(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }

    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : null;
  }

  private canBuildImagePreview(mimeType: string | null): boolean {
    const normalized = mimeType?.trim().toLowerCase();
    return Boolean(
      normalized &&
        (normalized === 'image/bmp' ||
          normalized === 'image/gif' ||
          normalized === 'image/jpeg' ||
          normalized === 'image/png' ||
          normalized === 'image/webp'),
    );
  }
}
