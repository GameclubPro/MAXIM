export function isRetiredPublishingSettingsRoute(search: string): boolean {
  const params = new URLSearchParams(search);
  return (
    params.get('focus') === 'broadcast' ||
    params.get('focus') === 'mailing' ||
    params.get('workspace') === 'autoposts' ||
    params.has('legacyKind') ||
    params.has('legacyId')
  );
}
