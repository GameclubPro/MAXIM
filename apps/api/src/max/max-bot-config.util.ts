import { z } from 'zod';
import { collectBotTokenSecrets } from '../common/bot-token.util';

const maxAdditionalBotSchema = z.object({
  id: z.string().trim().min(3),
  token: z.string().trim().min(10),
  tokenPrevious: z.string().trim().min(10).optional(),
  webhookSecretPath: z.string().trim().min(8),
  webhookHeaderSecret: z.string().trim().min(8),
  webhookHeaderSecretPrevious: z.string().trim().min(8).optional(),
  contactId: z.string().trim().regex(/^\d+$/u).optional(),
});

const maxAdditionalBotsSchema = z.array(maxAdditionalBotSchema);

export type AdditionalMaxBotConfig = z.infer<typeof maxAdditionalBotSchema>;

export type ResolvedMaxBotConfig = {
  id: string;
  token: string;
  tokenValidationSecrets: readonly string[];
  webhookSecretPath: string;
  webhookHeaderSecret: string;
  webhookHeaderSecrets: readonly string[];
  contactId: string | null;
  isDefault: boolean;
};

export function parseAdditionalMaxBotsJson(
  rawValue: string | null | undefined,
): AdditionalMaxBotConfig[] {
  const normalized = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!normalized) {
    return [];
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(normalized);
  } catch (error: unknown) {
    throw new Error(
      `MAX_BOTS_JSON must be valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const parsed = maxAdditionalBotsSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(
      `MAX_BOTS_JSON is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('; ')}`,
    );
  }

  const seenBotIds = new Set<string>();
  for (const bot of parsed.data) {
    const normalizedBotId = bot.id.trim();
    if (seenBotIds.has(normalizedBotId)) {
      throw new Error(`MAX_BOTS_JSON contains duplicate bot id "${normalizedBotId}"`);
    }
    seenBotIds.add(normalizedBotId);
  }

  return parsed.data.map((bot) => ({
    ...bot,
    id: bot.id.trim(),
    token: bot.token.trim(),
    tokenPrevious: bot.tokenPrevious?.trim(),
    webhookSecretPath: bot.webhookSecretPath.trim(),
    webhookHeaderSecret: bot.webhookHeaderSecret.trim(),
    webhookHeaderSecretPrevious: bot.webhookHeaderSecretPrevious?.trim(),
    contactId: bot.contactId?.trim(),
  }));
}

export function buildResolvedMaxBotConfigs(input: {
  defaultBot: {
    id: string;
    token: string;
    tokenPrevious?: string | null;
    webhookSecretPath: string;
    webhookHeaderSecret: string;
    webhookHeaderSecretPrevious?: string | null;
    contactId?: string | null;
  };
  additionalBotsJson?: string | null;
}): ResolvedMaxBotConfig[] {
  const defaultBotId = input.defaultBot.id.trim();
  const bots: ResolvedMaxBotConfig[] = [
    {
      id: defaultBotId,
      token: input.defaultBot.token.trim(),
      tokenValidationSecrets: collectBotTokenSecrets(
        input.defaultBot.token,
        input.defaultBot.tokenPrevious,
      ),
      webhookSecretPath: input.defaultBot.webhookSecretPath.trim(),
      webhookHeaderSecret: input.defaultBot.webhookHeaderSecret.trim(),
      webhookHeaderSecrets: collectBotTokenSecrets(
        input.defaultBot.webhookHeaderSecret,
        input.defaultBot.webhookHeaderSecretPrevious,
      ),
      contactId: normalizeContactId(input.defaultBot.contactId) ?? inferContactIdFromBotId(defaultBotId),
      isDefault: true,
    },
  ];

  for (const bot of parseAdditionalMaxBotsJson(input.additionalBotsJson)) {
    if (bot.id === defaultBotId) {
      throw new Error(`MAX_BOTS_JSON must not repeat default bot id "${defaultBotId}"`);
    }

    bots.push({
      id: bot.id,
      token: bot.token,
      tokenValidationSecrets: collectBotTokenSecrets(bot.token, bot.tokenPrevious),
      webhookSecretPath: bot.webhookSecretPath,
      webhookHeaderSecret: bot.webhookHeaderSecret,
      webhookHeaderSecrets: collectBotTokenSecrets(
        bot.webhookHeaderSecret,
        bot.webhookHeaderSecretPrevious,
      ),
      contactId: normalizeContactId(bot.contactId) ?? inferContactIdFromBotId(bot.id),
      isDefault: false,
    });
  }

  return bots;
}

export function normalizeContactId(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && /^\d+$/u.test(normalized) ? normalized : null;
}

export function inferContactIdFromBotId(botId: string): string | null {
  const normalized = botId.trim().replace(/^id/iu, '').replace(/_bot$/iu, '');
  const [primary] = normalized.split('_');
  return primary && /^\d+$/u.test(primary) ? primary : null;
}

export function buildBotIdVariants(value: string | null | undefined): Set<string> {
  if (typeof value !== 'string') {
    return new Set<string>();
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return new Set<string>();
  }

  const variants = new Set<string>([normalized]);
  if (normalized.startsWith('id') && normalized.length > 2) {
    variants.add(normalized.slice(2));
  }
  if (normalized.endsWith('_bot') && normalized.length > 4) {
    variants.add(normalized.slice(0, -4));
  }
  if (normalized.startsWith('id') && normalized.endsWith('_bot') && normalized.length > 6) {
    variants.add(normalized.slice(2, -4));
  }

  return variants;
}
