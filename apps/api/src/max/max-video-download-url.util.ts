type VideoUrlCandidate = {
  url: string;
  score: number;
};

export function extractMaxVideoDownloadUrl(value: unknown): string | null {
  const candidates: VideoUrlCandidate[] = [];
  const visit = (candidate: unknown, key: string, depth: number): void => {
    if (depth > 4) {
      return;
    }
    if (typeof candidate === 'string') {
      try {
        const parsed = new URL(candidate.trim());
        if (parsed.protocol !== 'https:') {
          return;
        }
        const normalizedKey = key.toLowerCase();
        if (
          normalizedKey.includes('hls') ||
          normalizedKey.includes('manifest') ||
          normalizedKey.includes('thumbnail') ||
          normalizedKey.includes('preview')
        ) {
          return;
        }
        const looksLikeMp4 = normalizedKey.includes('mp4') || /\.mp4$/iu.test(parsed.pathname);
        const looksDownloadable = normalizedKey.includes('download');
        if (!looksLikeMp4 && !looksDownloadable) {
          return;
        }
        const score = looksDownloadable ? 700 : 600;
        candidates.push({ url: parsed.toString(), score });
      } catch {
        return;
      }
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item) => visit(item, key, depth + 1));
      return;
    }
    if (!candidate || typeof candidate !== 'object') {
      return;
    }
    for (const [nestedKey, nestedValue] of Object.entries(candidate as Record<string, unknown>)) {
      visit(nestedValue, nestedKey, depth + 1);
    }
  };
  visit(value, 'root', 0);
  candidates.sort((left, right) => right.score - left.score);
  return candidates[0]?.url ?? null;
}
