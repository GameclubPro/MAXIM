import { BadRequestException } from '@nestjs/common';
import { parseMiniappBootTracePayload } from './miniapp-boot-trace.service';

function encodeBase64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('parseMiniappBootTracePayload', () => {
  it('sanitizes sensitive route, url, and detail values before logging', () => {
    const trace = parseMiniappBootTracePayload({
      phase: 'auth-start',
      sessionId: 'boot-session-1',
      sequence: 3,
      route: '/app/?initData=secret&screen=home',
      url: 'https://maxim.play-team.ru/app/?token=secret-token#hash=abc',
      elapsedMs: 42,
      ua: 'Mozilla/5.0 authorization: Bearer secret',
      platform: 'ios',
      details: {
        initData: 'full-init-data',
        nested: {
          authorization: 'Bearer secret',
          safe: 'ok',
          callbackUrl: '/next?access_token=secret&x=1',
          freeTextAuth: 'Authorization: InitData hash=secret&user=123',
        },
      },
    });

    expect(trace).toEqual({
      phase: 'auth-start',
      sessionId: 'boot-session-1',
      sequence: 3,
      route: '/app/?initData=[redacted]&screen=home',
      url: 'https://maxim.play-team.ru/app/?token=[redacted]#hash=[redacted]',
      elapsedMs: 42,
      ua: 'Mozilla/5.0 authorization: Bearer [redacted]',
      platform: 'ios',
      details: {
        initData: '[redacted]',
        nested: {
          authorization: '[redacted]',
          safe: 'ok',
          callbackUrl: '/next?access_token=[redacted]&x=1',
          freeTextAuth: 'Authorization: InitData [redacted]',
        },
      },
    });
  });

  it('redacts startapp and channel dialog launch payload previews', () => {
    const dialogToken = 'dialog-token-secret-123456';
    const encodedPayload = encodeBase64Url({
      v: 1,
      k: 'channel-dialog',
      c: '-100',
      m: 'comments',
      t: dialogToken,
    });
    const startParam = `cd-${encodedPayload}`;

    const trace = parseMiniappBootTracePayload({
      phase: 'route_resolved',
      route: `/app/?startapp=${startParam}&screen=dialog`,
      url: `https://major-maksimov.ru/app/#/?start_param=${startParam}&screen=dialog`,
      details: {
        startParam,
        launchPreview: `payload ${startParam}`,
        decodedPreview: {
          v: 1,
          k: 'channel-dialog',
          c: '-100',
          m: 'comments',
          t: dialogToken,
        },
      },
    });

    expect(trace).toEqual({
      phase: 'route_resolved',
      route: '/app/?startapp=[redacted]&screen=dialog',
      url: 'https://major-maksimov.ru/app/#/?start_param=[redacted]&screen=dialog',
      details: {
        startParam: '[redacted]',
        launchPreview: 'payload cd-[redacted]',
        decodedPreview: {
          v: 1,
          k: 'channel-dialog',
          c: '-100',
          m: 'comments',
          t: '[redacted]',
        },
      },
    });
    expect(JSON.stringify(trace)).not.toContain(dialogToken);
    expect(JSON.stringify(trace)).not.toContain(encodedPayload);
  });

  it('redacts exact search keys in routes, URLs, and details', () => {
    const trace = parseMiniappBootTracePayload({
      phase: 'route_resolved',
      route: '/app/publications?q=first&query=second&search=third&searchMode=all',
      url: 'https://major-maksimov.ru/app/publications?Q=first&QUERY=second&SEARCH=third',
      details: {
        q: 'first',
        query: 'second',
        search: 'third',
        searchMode: 'all',
      },
    });

    expect(trace).toEqual({
      phase: 'route_resolved',
      route: '/app/publications?q=[redacted]&query=[redacted]&search=[redacted]&searchMode=all',
      url: 'https://major-maksimov.ru/app/publications?Q=[redacted]&QUERY=[redacted]&SEARCH=[redacted]',
      details: {
        q: '[redacted]',
        query: '[redacted]',
        search: '[redacted]',
        searchMode: 'all',
      },
    });
  });

  it('drops route and URL context from publication API traces', () => {
    const trace = parseMiniappBootTracePayload({
      phase: 'publication_api',
      route: '/app/publications?q=private-search',
      url: 'https://major-maksimov.ru/app/publications?q=private-search',
      details: {
        operation: 'list',
        outcome: 'ok',
        durationMs: 120,
      },
    });

    expect(trace).toEqual({
      phase: 'publication_api',
      details: {
        operation: 'list',
        outcome: 'ok',
        durationMs: 120,
      },
    });
  });

  it('rejects invalid payloads', () => {
    expect(() =>
      parseMiniappBootTracePayload({
        phase: '',
        elapsedMs: -1,
      }),
    ).toThrow(BadRequestException);
  });

  it('drops unknown top-level fields', () => {
    expect(
      parseMiniappBootTracePayload({
        phase: 'ready',
        extra: 'ignored',
      }),
    ).toEqual({ phase: 'ready' });
  });

  it('ignores null optional top-level fields from early mini app boot clients', () => {
    expect(
      parseMiniappBootTracePayload({
        phase: 'index_loaded',
        sessionId: null,
        sequence: null,
        route: null,
        url: null,
        elapsedMs: null,
        ua: null,
        platform: null,
      }),
    ).toEqual({ phase: 'index_loaded' });
  });

  it('rejects oversized details', () => {
    expect(() =>
      parseMiniappBootTracePayload({
        phase: 'ready',
        details: { value: 'x'.repeat(9 * 1_024) },
      }),
    ).toThrow(BadRequestException);
  });
});
