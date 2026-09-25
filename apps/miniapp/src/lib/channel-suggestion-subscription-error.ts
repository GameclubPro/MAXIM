export function describeSuggestionSubscriptionError(error: unknown): string | null {
  if (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === 'SUGGESTION_SUBSCRIPTION_REQUIRED'
  ) {
    return 'Чтобы предложить пост, подпишитесь на канал и повторите отправку.';
  }
  return null;
}
