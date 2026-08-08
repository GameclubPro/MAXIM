import { channelPostSignatureUrlSchema } from '@maxim/contracts';

export type ParsedChannelPostSignatureUrl = {
  error: string | null;
  url: string;
};

export function parseChannelPostSignatureUrl(value: string): ParsedChannelPostSignatureUrl {
  const normalized = value.trim();
  if (!normalized) {
    return { error: null, url: '' };
  }

  const parsed = channelPostSignatureUrlSchema.safeParse(normalized);
  if (parsed.success) {
    return { error: null, url: parsed.data };
  }

  return {
    error: parsed.error.issues[0]?.message ?? 'Укажите корректную ссылку (http/https).',
    url: '',
  };
}

export function resolveChannelPostSignaturePreviewUrl(
  customUrl: string,
  channelFallbackUrl: string,
): ParsedChannelPostSignatureUrl {
  if (customUrl.trim()) {
    return parseChannelPostSignatureUrl(customUrl);
  }

  return {
    error: null,
    url: parseChannelPostSignatureUrl(channelFallbackUrl).url,
  };
}
