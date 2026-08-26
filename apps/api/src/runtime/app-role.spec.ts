import { normalizeAppRole, resolveHttpListenHost, roleRunsHttp } from './app-role';

describe('application role HTTP boundary', () => {
  it('keeps ordinary worker roles headless', () => {
    expect(roleRunsHttp(normalizeAppRole('moderation'), 'api-moderation-background')).toBe(false);
    expect(roleRunsHttp(normalizeAppRole('enqueue'), 'api-enqueue')).toBe(false);
    expect(roleRunsHttp(normalizeAppRole('action'), 'api-action')).toBe(false);
    expect(roleRunsHttp(normalizeAppRole('publisher'), 'api-publisher')).toBe(false);
  });

  it('exposes media-analysis health only on container loopback', () => {
    expect(roleRunsHttp(normalizeAppRole('moderation'), 'api-media-analysis')).toBe(true);
    expect(resolveHttpListenHost('api-media-analysis')).toBe('127.0.0.1');
  });

  it('preserves externally reachable HTTP for ingress and admin roles', () => {
    expect(roleRunsHttp(normalizeAppRole('ingress'), 'api-ingress')).toBe(true);
    expect(roleRunsHttp(normalizeAppRole('admin'), 'api-admin')).toBe(true);
    expect(resolveHttpListenHost('api-ingress')).toBe('0.0.0.0');
    expect(resolveHttpListenHost('api-admin')).toBe('0.0.0.0');
  });
});
