export function createClientRequestId(prefix = 'req'): string {
  const normalizedPrefix = prefix.replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 24) || 'req';
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${normalizedPrefix}_${crypto.randomUUID().replace(/-/gu, '')}`;
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return `${normalizedPrefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  throw new Error('Secure request identity is unavailable');
}

export type ContentBoundRequestIdentity = {
  requestId: string | null;
  draftRevision: number;
  requestRevision: number | null;
};

export function createContentBoundRequestIdentity(): ContentBoundRequestIdentity {
  return {
    requestId: null,
    draftRevision: 0,
    requestRevision: null,
  };
}

export function advanceContentBoundRequestIdentity(
  current: ContentBoundRequestIdentity,
): ContentBoundRequestIdentity {
  return {
    requestId: null,
    draftRevision: current.draftRevision + 1,
    requestRevision: null,
  };
}

export function resolveContentBoundRequestIdentity(
  current: ContentBoundRequestIdentity,
  prefix = 'req',
): { identity: ContentBoundRequestIdentity; requestId: string } {
  if (
    current.requestId &&
    current.requestRevision !== null &&
    current.requestRevision === current.draftRevision
  ) {
    return { identity: current, requestId: current.requestId };
  }

  const requestId = createClientRequestId(prefix);
  return {
    identity: {
      ...current,
      requestId,
      requestRevision: current.draftRevision,
    },
    requestId,
  };
}
