import { z } from 'zod';
import { botSpeechPersonaSchema, type BotSpeechPersona } from '@maxim/contracts';
import { collectBotTokenSecrets } from '../common/bot-token.util';

export const maxBotLifecycleStateSchema = z.enum(['active', 'dormant', 'draining', 'disabled']);
export type MaxBotLifecycleState = z.infer<typeof maxBotLifecycleStateSchema>;

const maxAdditionalBotSchema = z.object({
  id: z.string().trim().min(3),
  label: z.string().trim().min(1).max(64).optional(),
  characterName: z.string().trim().min(1).max(128).optional(),
  speechPersona: botSpeechPersonaSchema.optional().default('male'),
  token: z.string().trim().min(10),
  tokenPrevious: z.string().trim().min(10).optional(),
  webhookSecretPath: z.string().trim().min(8),
  webhookHeaderSecret: z.string().trim().min(8),
  webhookHeaderSecretPrevious: z.string().trim().min(8).optional(),
  contactId: z.string().trim().regex(/^\d+$/u).optional(),
  state: maxBotLifecycleStateSchema.default('active'),
  visibleInAdmin: z.boolean().optional(),
});

const maxAdditionalBotsSchema = z.array(maxAdditionalBotSchema);

export type AdditionalMaxBotConfig = z.infer<typeof maxAdditionalBotSchema>;

export type ResolvedMaxBotConfig = {
  id: string;
  label: string;
  characterName: string;
  speechPersona: BotSpeechPersona;
  token: string;
  tokenValidationSecrets: readonly string[];
  webhookSecretPath: string;
  webhookHeaderSecret: string;
  webhookHeaderSecrets: readonly string[];
  contactId: string | null;
  state: MaxBotLifecycleState;
  visibleInAdmin: boolean;
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
      `MAX_BOTS_JSON must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
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
    label: bot.label?.trim(),
    characterName: bot.characterName?.trim(),
    speechPersona: bot.speechPersona,
    state: bot.state,
    visibleInAdmin: bot.visibleInAdmin,
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
    label?: string | null;
    characterName?: string | null;
    speechPersona?: BotSpeechPersona | null;
  };
  additionalBotsJson?: string | null;
}): ResolvedMaxBotConfig[] {
  const defaultBotId = input.defaultBot.id.trim();
  const defaultBotLabel = normalizeBotLabel(input.defaultBot.label) ?? defaultBotId;
  const defaultBotSpeechPersona = input.defaultBot.speechPersona ?? 'male';
  const bots: ResolvedMaxBotConfig[] = [
    {
      id: defaultBotId,
      label: defaultBotLabel,
      characterName: resolveBotCharacterName({
        explicitCharacterName: input.defaultBot.characterName,
        label: defaultBotLabel,
        speechPersona: defaultBotSpeechPersona,
        isDefault: true,
      }),
      speechPersona: defaultBotSpeechPersona,
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
      contactId:
        normalizeContactId(input.defaultBot.contactId) ?? inferContactIdFromBotId(defaultBotId),
      state: 'active',
      visibleInAdmin: true,
      isDefault: true,
    },
  ];

  for (const bot of parseAdditionalMaxBotsJson(input.additionalBotsJson)) {
    if (bot.id === defaultBotId) {
      throw new Error(`MAX_BOTS_JSON must not repeat default bot id "${defaultBotId}"`);
    }

    bots.push({
      id: bot.id,
      label: normalizeBotLabel(bot.label) ?? bot.id,
      characterName: resolveBotCharacterName({
        explicitCharacterName: bot.characterName,
        label: normalizeBotLabel(bot.label) ?? bot.id,
        speechPersona: bot.speechPersona,
        isDefault: false,
      }),
      speechPersona: bot.speechPersona,
      token: bot.token,
      tokenValidationSecrets: collectBotTokenSecrets(bot.token, bot.tokenPrevious),
      webhookSecretPath: bot.webhookSecretPath,
      webhookHeaderSecret: bot.webhookHeaderSecret,
      webhookHeaderSecrets: collectBotTokenSecrets(
        bot.webhookHeaderSecret,
        bot.webhookHeaderSecretPrevious,
      ),
      contactId: normalizeContactId(bot.contactId) ?? inferContactIdFromBotId(bot.id),
      state: bot.state,
      visibleInAdmin: bot.visibleInAdmin ?? bot.state !== 'disabled',
      isDefault: false,
    });
  }

  return bots;
}

export function normalizeContactId(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && /^\d+$/u.test(normalized) ? normalized : null;
}

function normalizeBotLabel(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function normalizeBotCharacterName(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function resolveBotCharacterName(params: {
  explicitCharacterName: string | null | undefined;
  label: string;
  speechPersona: BotSpeechPersona;
  isDefault: boolean;
}): string {
  const explicitCharacterName = normalizeBotCharacterName(params.explicitCharacterName);
  if (explicitCharacterName) {
    return explicitCharacterName;
  }

  if (params.isDefault) {
    return params.speechPersona === 'female' ? 'Капитан Максимова' : 'Майор Максимов';
  }

  return params.label;
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
