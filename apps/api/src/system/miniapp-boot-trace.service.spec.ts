import { BadRequestException } from '@nestjs/common';
import { parseMiniappBootTracePayload } from './miniapp-boot-trace.service';

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

  it('rejects oversized details', () => {
    expect(() =>
      parseMiniappBootTracePayload({
        phase: 'ready',
        details: { value: 'x'.repeat(9 * 1_024) },
      }),
    ).toThrow(BadRequestException);
  });
});
