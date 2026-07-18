export function createAdminRequestHeaders(
  accessCode: string,
  options: { json?: boolean } = {},
): Record<string, string> {
  return {
    Accept: 'application/json',
    'X-Admin-Access-Code': accessCode.trim(),
    ...(options.json ? { 'Content-Type': 'application/json' } : {}),
  };
}
