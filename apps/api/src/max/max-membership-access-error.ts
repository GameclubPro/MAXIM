/** Membership endpoints can return a missing user or an opaque gateway error. */
export function resolveExplicitMembershipAccessDenial(error: unknown): string | null {
  const response = (error as { response?: { status?: unknown; data?: { code?: unknown } } })
    ?.response;
  if (response?.status !== 403 && response?.status !== 404) return null;
  const code =
    typeof response.data?.code === 'string' ? response.data.code.trim().toLowerCase() : '';
  // FLAG: A bare 403/404 or user.not.found is not proof that the bot lost its chat role.
  return ['access.denied', 'chat.denied', 'chat.not.found'].includes(code) ? code : null;
}
