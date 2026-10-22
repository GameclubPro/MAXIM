export function formatDialogAttachmentSize(bytes: number | null | undefined): string {
  const normalized = typeof bytes === 'number' && Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (normalized >= 1_000_000) {
    return `${(normalized / 1_000_000).toFixed(1)} MB`;
  }

  if (normalized >= 1_000) {
    return `${Math.max(1, Math.round(normalized / 1_000))} KB`;
  }

  return `${normalized} B`;
}
