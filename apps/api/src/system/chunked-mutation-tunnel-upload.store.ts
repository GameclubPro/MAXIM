import { BadRequestException } from '@nestjs/common';

export type ChunkedMutationTunnelUploadMetadata = {
  method: string;
  path: string;
  contentType: string | undefined;
  authHash: string;
  authUserKey: string;
  chunkCount: number;
};

export type ChunkedMutationTunnelUpload = ChunkedMutationTunnelUploadMetadata & {
  chunks: Array<Buffer | undefined>;
  receivedCount: number;
  receivedBytes: number;
  expiresAtMs: number;
  committing: boolean;
};

export type ChunkedMutationTunnelUploadLimits = {
  maxActiveUploads: number;
  maxActiveUploadsPerUser: number;
  maxBodyBytes: number;
  maxRetainedBytes: number;
  ttlMs: number;
};

export const DEFAULT_CHUNKED_MUTATION_TUNNEL_UPLOAD_LIMITS: Readonly<ChunkedMutationTunnelUploadLimits> =
  {
    maxActiveUploads: 16,
    maxActiveUploadsPerUser: 2,
    maxBodyBytes: 34 * 1024 * 1024,
    maxRetainedBytes: 48 * 1024 * 1024,
    ttlMs: 3 * 60 * 1_000,
  };

export class ChunkedMutationTunnelUploadStore {
  private readonly limits: ChunkedMutationTunnelUploadLimits;
  private readonly uploads = new Map<string, ChunkedMutationTunnelUpload>();
  private readonly activeUploadsByUser = new Map<string, number>();
  private retainedBytes = 0;
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(limits: Partial<ChunkedMutationTunnelUploadLimits> = {}) {
    this.limits = {
      ...DEFAULT_CHUNKED_MUTATION_TUNNEL_UPLOAD_LIMITS,
      ...limits,
    };
  }

  storeChunk(params: {
    uploadId: string;
    metadata: ChunkedMutationTunnelUploadMetadata;
    chunkIndex: number;
    chunk: Buffer;
  }): { receivedCount: number; chunkCount: number } {
    this.cleanupExpiredUploads();

    let upload = this.uploads.get(params.uploadId);
    if (upload) {
      this.assertMetadataMatches(upload, params.metadata);
      if (upload.committing) {
        throw new BadRequestException('Tunnel upload is being committed');
      }
    } else {
      this.assertUploadCapacity(params.metadata.authUserKey);
    }

    const previousChunk = upload?.chunks[params.chunkIndex];
    const retainedBytesDelta = params.chunk.length - (previousChunk?.length ?? 0);
    const nextUploadBytes = (upload?.receivedBytes ?? 0) + retainedBytesDelta;
    if (nextUploadBytes > this.limits.maxBodyBytes) {
      throw new BadRequestException('Tunnel body is too large');
    }
    if (this.retainedBytes + retainedBytesDelta > this.limits.maxRetainedBytes) {
      throw new BadRequestException('Tunnel upload capacity is exhausted');
    }

    if (!upload) {
      upload = {
        ...params.metadata,
        chunks: new Array<Buffer | undefined>(params.metadata.chunkCount),
        receivedCount: 0,
        receivedBytes: 0,
        expiresAtMs: 0,
        committing: false,
      };
      this.uploads.set(params.uploadId, upload);
      this.activeUploadsByUser.set(
        upload.authUserKey,
        (this.activeUploadsByUser.get(upload.authUserKey) ?? 0) + 1,
      );
    }

    if (!previousChunk) {
      upload.receivedCount += 1;
    }
    upload.receivedBytes = nextUploadBytes;
    upload.chunks[params.chunkIndex] = params.chunk;
    upload.expiresAtMs = Date.now() + this.limits.ttlMs;
    this.retainedBytes += retainedBytesDelta;
    this.scheduleCleanup();

    return {
      receivedCount: upload.receivedCount,
      chunkCount: upload.chunkCount,
    };
  }

  beginCompletedUpload(
    uploadId: string,
    metadata: ChunkedMutationTunnelUploadMetadata,
  ): ChunkedMutationTunnelUpload {
    this.cleanupExpiredUploads();
    const upload = this.uploads.get(uploadId);
    if (!upload) {
      throw new BadRequestException('Tunnel upload was not found');
    }

    this.assertMetadataMatches(upload, metadata);
    if (upload.committing) {
      throw new BadRequestException('Tunnel upload is being committed');
    }
    if (upload.receivedCount !== upload.chunkCount || upload.chunks.some((chunk) => !chunk)) {
      throw new BadRequestException('Tunnel upload is incomplete');
    }

    upload.committing = true;
    upload.expiresAtMs = Date.now() + this.limits.ttlMs;
    this.scheduleCleanup();
    return upload;
  }

  deleteUpload(uploadId: string): boolean {
    const deleted = this.removeUpload(uploadId);
    if (deleted) {
      this.scheduleCleanup();
    }
    return deleted;
  }

  getUsage(): {
    activeUploads: number;
    retainedBytes: number;
    activeUploadsByUser: ReadonlyMap<string, number>;
  } {
    return {
      activeUploads: this.uploads.size,
      retainedBytes: this.retainedBytes,
      activeUploadsByUser: new Map(this.activeUploadsByUser),
    };
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.uploads.clear();
    this.activeUploadsByUser.clear();
    this.retainedBytes = 0;
  }

  private assertUploadCapacity(authUserKey: string): void {
    if (this.uploads.size >= this.limits.maxActiveUploads) {
      throw new BadRequestException('Tunnel upload capacity is exhausted');
    }
    if ((this.activeUploadsByUser.get(authUserKey) ?? 0) >= this.limits.maxActiveUploadsPerUser) {
      throw new BadRequestException('Too many active tunnel uploads');
    }
  }

  private assertMetadataMatches(
    upload: ChunkedMutationTunnelUpload,
    metadata: ChunkedMutationTunnelUploadMetadata,
  ): void {
    if (
      upload.method !== metadata.method ||
      upload.path !== metadata.path ||
      upload.contentType !== metadata.contentType ||
      upload.authHash !== metadata.authHash ||
      upload.authUserKey !== metadata.authUserKey ||
      upload.chunkCount !== metadata.chunkCount
    ) {
      throw new BadRequestException('Tunnel upload metadata mismatch');
    }
  }

  private cleanupExpiredUploads(): void {
    const now = Date.now();
    let removedAny = false;
    for (const [uploadId, upload] of this.uploads.entries()) {
      if (upload.expiresAtMs <= now) {
        this.removeUpload(uploadId);
        removedAny = true;
      }
    }

    if (removedAny) {
      this.scheduleCleanup();
    }
  }

  private removeUpload(uploadId: string): boolean {
    const upload = this.uploads.get(uploadId);
    if (!upload || !this.uploads.delete(uploadId)) {
      return false;
    }

    this.retainedBytes -= upload.receivedBytes;
    const userUploadCount = this.activeUploadsByUser.get(upload.authUserKey);
    if (userUploadCount === undefined || userUploadCount <= 1) {
      this.activeUploadsByUser.delete(upload.authUserKey);
    } else {
      this.activeUploadsByUser.set(upload.authUserKey, userUploadCount - 1);
    }
    return true;
  }

  private scheduleCleanup(): void {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    if (this.uploads.size === 0) {
      return;
    }

    let nextExpiryMs = Number.POSITIVE_INFINITY;
    for (const upload of this.uploads.values()) {
      nextExpiryMs = Math.min(nextExpiryMs, upload.expiresAtMs);
    }

    this.cleanupTimer = setTimeout(
      () => {
        this.cleanupTimer = undefined;
        this.cleanupExpiredUploads();
        this.scheduleCleanup();
      },
      Math.max(0, nextExpiryMs - Date.now()),
    );
    this.cleanupTimer.unref();
  }
}
