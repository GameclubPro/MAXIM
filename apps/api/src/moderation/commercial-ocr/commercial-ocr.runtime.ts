import type { ConfigService } from '@nestjs/config';

export const COMMERCIAL_OCR_ROLLOUT_MODES = ['off', 'shadow', 'canary', 'on'] as const;

export type CommercialOcrRolloutMode = (typeof COMMERCIAL_OCR_ROLLOUT_MODES)[number];

export type CommercialOcrRuntimePolicy = {
  mode: CommercialOcrRolloutMode;
  process: boolean;
  enforce: boolean;
};

export function resolveCommercialOcrRolloutMode(
  configService?: Pick<ConfigService, 'get'>,
): CommercialOcrRolloutMode {
  const configured = configService?.get<string>('COMMERCIAL_OCR_ROLLOUT_MODE');
  return COMMERCIAL_OCR_ROLLOUT_MODES.includes(configured as CommercialOcrRolloutMode)
    ? (configured as CommercialOcrRolloutMode)
    : 'off';
}

export function resolveCommercialOcrRuntimePolicy(params: {
  chatId: string;
  configService?: Pick<ConfigService, 'get'>;
}): CommercialOcrRuntimePolicy {
  const mode = resolveCommercialOcrRolloutMode(params.configService);
  if (mode === 'off') {
    return { mode, process: false, enforce: false };
  }
  if (mode === 'shadow') {
    return { mode, process: true, enforce: false };
  }
  if (mode === 'on') {
    return { mode, process: true, enforce: true };
  }

  // FLAG: Canary enforcement is an exact allowlist. Wildcards must never expand it globally.
  const canaryChatIds = parseExactIdSet(
    params.configService?.get<string>('COMMERCIAL_OCR_CANARY_CHAT_IDS'),
  );
  return {
    mode,
    process: true,
    enforce: canaryChatIds.has(params.chatId),
  };
}

function parseExactIdSet(value: unknown): Set<string> {
  if (typeof value !== 'string') {
    return new Set();
  }
  return new Set(
    value
      .split(/[\s,;]+/u)
      .map((item) => item.trim())
      .filter((item) => item.length > 0 && item !== '*'),
  );
}
