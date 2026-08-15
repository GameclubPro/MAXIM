const ADMIN_MAX_MEDIA_FILE_NAME_MAX_LENGTH = 128;

export function canonicalizeAdminMaxMediaFileName(
  fileName: string,
  extension: string,
  fallbackStem: string,
): string {
  const basename =
    fileName
      .normalize('NFC')
      .trim()
      .split(/[\\/]+/u)
      .pop()
      ?.trim() ?? '';
  const sanitized = basename
    .replace(/[\p{Cc}\p{Cf}]+/gu, '_')
    .replace(/[<>:"|?*]+/gu, '_')
    .replace(/_+/gu, '_')
    .replace(/\s+/gu, ' ')
    .replace(/[. ]+$/u, '')
    .trim();
  const requestedStem = sanitized
    .replace(/\.[^./\\]+$/u, '')
    .replace(/[. ]+$/u, '')
    .trim();
  const suffix = `.${extension}`;
  const maxStemLength = ADMIN_MAX_MEDIA_FILE_NAME_MAX_LENGTH - suffix.length;
  const truncatedStem = (requestedStem || fallbackStem)
    .slice(0, Math.max(1, maxStemLength))
    .replace(/[. ]+$/u, '');
  return `${truncatedStem || fallbackStem.slice(0, Math.max(1, maxStemLength))}${suffix}`;
}
