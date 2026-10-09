const missingRequestedIdErrors = new WeakSet<object>();

export class MaxExactMessageLookupMissingIdError extends Error {
  constructor() {
    super('MAX direct message lookup returned a response without the requested id');
    this.name = 'MaxExactMessageLookupMissingIdError';
    missingRequestedIdErrors.add(this);
  }
}

// FLAG: Only local response validation proves this read failure; names and text do not.
export function isMaxExactMessageLookupMissingIdError(
  error: unknown,
): error is MaxExactMessageLookupMissingIdError {
  return Boolean(error && typeof error === 'object' && missingRequestedIdErrors.has(error));
}
