import {
  resolveCommercialOcrRolloutMode,
  resolveCommercialOcrRuntimePolicy,
} from './commercial-ocr.runtime';

function config(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] };
}

describe('commercial OCR runtime policy', () => {
  it('fails closed when the rollout is absent or invalid', () => {
    expect(resolveCommercialOcrRolloutMode(config({}))).toBe('off');
    expect(resolveCommercialOcrRolloutMode(config({ COMMERCIAL_OCR_ROLLOUT_MODE: 'full' }))).toBe(
      'off',
    );
  });

  it('processes shadow traffic without authorizing deletion', () => {
    expect(
      resolveCommercialOcrRuntimePolicy({
        chatId: 'chat-1',
        configService: config({ COMMERCIAL_OCR_ROLLOUT_MODE: 'shadow' }),
      }),
    ).toEqual({ mode: 'shadow', process: true, enforce: false });
  });

  it('requires an exact canary chat id and ignores wildcards', () => {
    const configService = config({
      COMMERCIAL_OCR_ROLLOUT_MODE: 'canary',
      COMMERCIAL_OCR_CANARY_CHAT_IDS: '*, chat-2',
    });
    expect(resolveCommercialOcrRuntimePolicy({ chatId: 'chat-1', configService }).enforce).toBe(
      false,
    );
    expect(resolveCommercialOcrRuntimePolicy({ chatId: 'chat-2', configService }).enforce).toBe(
      true,
    );
  });
});
