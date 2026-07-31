export function extractHttpStatusCode(error: unknown): number | null {
  const responseStatus = (error as { response?: { status?: unknown } } | null)?.response?.status;
  if (typeof responseStatus === 'number') {
    return responseStatus;
  }
  const directStatus = (error as { status?: unknown } | null)?.status;
  if (typeof directStatus === 'number') {
    return directStatus;
  }
  const getStatus = (error as { getStatus?: unknown } | null)?.getStatus;
  if (typeof getStatus !== 'function') {
    return null;
  }
  try {
    const resolvedStatus = getStatus.call(error);
    return typeof resolvedStatus === 'number' ? resolvedStatus : null;
  } catch {
    return null;
  }
}
