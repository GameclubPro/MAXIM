import { resolveImageTextStopListOcrRuntimePolicy } from './image-text-stop-list.runtime';

function config(value: unknown) {
  return { get: () => value };
}

describe('image text stop-list OCR runtime policy', () => {
  it('defaults to observation-only processing', () => {
    expect(resolveImageTextStopListOcrRuntimePolicy({ sandboxBoundaryVerified: true })).toEqual({
      mode: 'shadow',
      process: true,
      enforce: false,
    });
  });

  it('requires both on mode and a verified sandbox boundary to enforce', () => {
    expect(
      resolveImageTextStopListOcrRuntimePolicy({
        configService: config('on'),
        sandboxBoundaryVerified: false,
      }),
    ).toEqual({ mode: 'on', process: true, enforce: false });
    expect(
      resolveImageTextStopListOcrRuntimePolicy({
        configService: config('on'),
        sandboxBoundaryVerified: true,
      }),
    ).toEqual({ mode: 'on', process: true, enforce: true });
  });

  it('supports a hard processing kill switch and rejects unknown modes', () => {
    expect(
      resolveImageTextStopListOcrRuntimePolicy({
        configService: config('off'),
        sandboxBoundaryVerified: true,
      }),
    ).toEqual({ mode: 'off', process: false, enforce: false });
    expect(
      resolveImageTextStopListOcrRuntimePolicy({
        configService: config('unexpected'),
        sandboxBoundaryVerified: true,
      }),
    ).toEqual({ mode: 'shadow', process: true, enforce: false });
  });
});
