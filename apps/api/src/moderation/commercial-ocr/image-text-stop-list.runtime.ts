import type { ConfigService } from '@nestjs/config';

export const IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODES = ['off', 'shadow', 'on'] as const;

export type ImageTextStopListOcrRolloutMode =
  (typeof IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODES)[number];

export type ImageTextStopListOcrRuntimePolicy = Readonly<{
  mode: ImageTextStopListOcrRolloutMode;
  process: boolean;
  enforce: boolean;
}>;

export function resolveImageTextStopListOcrRuntimePolicy(params: {
  configService?: Pick<ConfigService, 'get'>;
  sandboxBoundaryVerified: boolean;
}): ImageTextStopListOcrRuntimePolicy {
  const configured = params.configService?.get<string>('IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODE');
  const mode = IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODES.includes(
    configured as ImageTextStopListOcrRolloutMode,
  )
    ? (configured as ImageTextStopListOcrRolloutMode)
    : 'shadow';

  return {
    mode,
    process: mode !== 'off',
    enforce: mode === 'on' && params.sandboxBoundaryVerified,
  };
}
