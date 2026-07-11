export async function saveUntilLatestDraftIsPersisted<T>(params: {
  getCurrentKey: () => string;
  getSavedKey: (saved: T) => string;
  save: () => Promise<T | null>;
  maxAttempts?: number;
}): Promise<boolean> {
  const maxAttempts = params.maxAttempts ?? 3;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const saved = await params.save();
    if (!saved) {
      return false;
    }

    if (params.getSavedKey(saved) === params.getCurrentKey()) {
      return true;
    }
  }

  return false;
}
