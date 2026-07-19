const MUTATION_TUNNEL_PREFERRED_HOSTS = ['api-cdn.flex-craft.ru', 'api2.major-maksimov.ru'];

export function isMutationTunnelPreferredHost(apiBase: string): boolean {
  try {
    return MUTATION_TUNNEL_PREFERRED_HOSTS.includes(
      new URL(
        apiBase,
        typeof window === 'undefined' ? 'https://miniapp.local' : window.location.href,
      ).hostname,
    );
  } catch {
    return false;
  }
}
