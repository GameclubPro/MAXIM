export class PublisherSuggestionDraftOpenGate {
  private readonly inFlight = new Set<string>();
  private navigationCommitted = false;

  tryStart(suggestionId: string): string | null {
    const normalizedSuggestionId = suggestionId.trim();
    if (
      !normalizedSuggestionId ||
      this.navigationCommitted ||
      this.inFlight.has(normalizedSuggestionId) ||
      this.inFlight.size > 0
    ) {
      return null;
    }
    this.inFlight.add(normalizedSuggestionId);
    return normalizedSuggestionId;
  }

  finish(suggestionId: string): void {
    this.inFlight.delete(suggestionId.trim());
  }

  tryCommitNavigation(): boolean {
    if (this.navigationCommitted) {
      return false;
    }
    this.navigationCommitted = true;
    return true;
  }

  reset(blockNavigation = false): void {
    this.inFlight.clear();
    this.navigationCommitted = blockNavigation;
  }
}
