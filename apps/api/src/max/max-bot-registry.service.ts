import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  buildBotIdVariants,
  buildResolvedMaxBotConfigs,
  type ResolvedMaxBotConfig,
} from './max-bot-config.util';
import {
  canDiscoverChatsForBotState,
  canExecuteActionsForBotState,
  isOperationalBotState,
} from './max-bot-state.util';
import { MAX_REQUIRED_WEBHOOK_UPDATE_TYPES } from './max-webhook-subscription.constants';

export type MaxBotDefinition = ResolvedMaxBotConfig & {
  webhookUrl: string | null;
  maskedWebhookUrl: string | null;
};

@Injectable()
export class MaxBotRegistryService {
  private readonly bots: readonly MaxBotDefinition[];
  private readonly botsById: ReadonlyMap<string, MaxBotDefinition>;
  private readonly appBaseUrl: string | null;
  private readonly webhookBaseUrl: string | null;
  private readonly defaultBot: MaxBotDefinition;
  private readonly entryBot: MaxBotDefinition;
  private readonly knownBotUserIdVariants: ReadonlySet<string>;

  constructor(configService: ConfigService) {
    this.appBaseUrl = this.normalizeAppBaseUrl(configService.get<string>('APP_BASE_URL'));
    this.webhookBaseUrl = this.normalizeAppBaseUrl(
      configService.get<string>('MAX_WEBHOOK_BASE_URL') ?? this.appBaseUrl ?? undefined,
    );
    this.bots = buildResolvedMaxBotConfigs({
      defaultBot: {
        id: configService.getOrThrow<string>('MAX_BOT_ID'),
        label: configService.get<string>('MAX_BOT_LABEL'),
        characterName: configService.get<string>('MAX_BOT_CHARACTER_NAME'),
        speechPersona: configService.get<'male' | 'female' | 'neutral'>('MAX_BOT_SPEECH_PERSONA'),
        token: configService.getOrThrow<string>('MAX_BOT_TOKEN'),
        tokenPrevious: configService.get<string>('MAX_BOT_TOKEN_PREVIOUS'),
        webhookSecretPath: configService.getOrThrow<string>('MAX_WEBHOOK_SECRET_PATH'),
        webhookHeaderSecret: configService.getOrThrow<string>('MAX_WEBHOOK_HEADER_SECRET'),
        webhookHeaderSecretPrevious: configService.get<string>(
          'MAX_WEBHOOK_HEADER_SECRET_PREVIOUS',
        ),
        contactId: configService.get<string>('MAX_BOT_CONTACT_ID'),
      },
      additionalBotsJson: configService.get<string>('MAX_BOTS_JSON'),
    }).map((bot) => ({
      ...bot,
      webhookUrl: this.buildWebhookUrl(bot.id, bot.webhookSecretPath),
      maskedWebhookUrl: this.maskWebhookUrl(this.buildWebhookUrl(bot.id, bot.webhookSecretPath)),
    }));
    this.botsById = new Map(this.bots.map((bot) => [bot.id, bot]));
    this.defaultBot = this.bots[0]!;
    this.entryBot = this.resolveEntryBot(configService.get<string>('MAX_ENTRY_BOT_ID'));
    this.knownBotUserIdVariants = new Set(
      this.bots.flatMap((bot) => [...buildBotIdVariants(bot.id)]),
    );
  }

  getDefaultBot(): MaxBotDefinition {
    return this.defaultBot;
  }

  getEntryBot(): MaxBotDefinition {
    return this.entryBot;
  }

  getAllBots(): readonly MaxBotDefinition[] {
    return this.bots;
  }

  getOperationalBots(): readonly MaxBotDefinition[] {
    return this.bots.filter((bot) => isOperationalBotState(bot.state));
  }

  getDiscoveryBots(): readonly MaxBotDefinition[] {
    return this.bots.filter((bot) => canDiscoverChatsForBotState(bot.state));
  }

  getActionableBots(): readonly MaxBotDefinition[] {
    return this.bots.filter((bot) => canExecuteActionsForBotState(bot.state));
  }

  getAdminVisibleBots(): readonly MaxBotDefinition[] {
    return this.bots.filter((bot) => bot.visibleInAdmin);
  }

  getBotById(botId: string | null | undefined): MaxBotDefinition | null {
    const normalized = typeof botId === 'string' ? botId.trim() : '';
    return normalized ? (this.botsById.get(normalized) ?? null) : null;
  }

  getRequiredWebhookUpdateTypes(): readonly string[] {
    return [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES];
  }

  getValidationTokens(): readonly string[] {
    return this.getOperationalBots().flatMap((bot) => bot.tokenValidationSecrets);
  }

  getValidationTokensForBot(botId: string | null | undefined): readonly string[] {
    const bot = this.getBotById(botId) ?? this.defaultBot;
    if (!isOperationalBotState(bot.state)) {
      return [];
    }
    return bot.tokenValidationSecrets;
  }

  getKnownBotUserIdVariants(): ReadonlySet<string> {
    return this.knownBotUserIdVariants;
  }

  isKnownBotUserId(userId: string | null | undefined): boolean {
    const variants = buildBotIdVariants(userId);
    for (const variant of variants) {
      if (this.knownBotUserIdVariants.has(variant)) {
        return true;
      }
    }

    return false;
  }

  resolveWebhookBot(params: {
    botId: string;
    secretPath: string;
    providedHeaderSecret: string;
  }): MaxBotDefinition | null {
    const bot = this.getBotById(params.botId);
    if (!bot || !isOperationalBotState(bot.state)) {
      return null;
    }

    if (params.secretPath.trim() !== bot.webhookSecretPath) {
      return null;
    }

    return this.isMatchingAnyWebhookSecret(params.providedHeaderSecret, bot.webhookHeaderSecrets)
      ? bot
      : null;
  }

  computeWebhookHeaderSecretFingerprint(botId: string): string | null {
    const bot = this.getBotById(botId);
    if (!bot) {
      return null;
    }

    return createHash('sha256').update(bot.webhookHeaderSecret).digest('hex');
  }

  getConfiguredWebhookSubscriptionTarget(botId: string): {
    url: string | null;
    maskedUrl: string | null;
  } {
    const bot = this.getBotById(botId) ?? this.defaultBot;
    if (!isOperationalBotState(bot.state)) {
      return {
        url: null,
        maskedUrl: null,
      };
    }
    return {
      url: bot.webhookUrl,
      maskedUrl: bot.maskedWebhookUrl,
    };
  }

  private normalizeAppBaseUrl(value: string | undefined): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized ? normalized.replace(/\/+$/u, '') : null;
  }

  private resolveEntryBot(configuredBotId: string | undefined): MaxBotDefinition {
    const normalized = typeof configuredBotId === 'string' ? configuredBotId.trim() : '';
    const configuredBot = normalized ? (this.botsById.get(normalized) ?? null) : null;
    if (configuredBot && canExecuteActionsForBotState(configuredBot.state)) {
      return configuredBot;
    }

    return this.defaultBot;
  }

  private buildWebhookUrl(botId: string, secretPath: string): string | null {
    if (!this.webhookBaseUrl) {
      return null;
    }

    return `${this.webhookBaseUrl}/api/webhook/max/${encodeURIComponent(botId)}/${encodeURIComponent(secretPath)}`;
  }

  private maskWebhookUrl(url: string | null): string | null {
    if (!url) {
      return null;
    }

    const trimmed = url.trim();
    const lastSlash = trimmed.lastIndexOf('/');
    if (lastSlash < 0) {
      return trimmed;
    }

    return `${trimmed.slice(0, lastSlash + 1)}***`;
  }

  private isMatchingAnyWebhookSecret(provided: string, expectedValues: readonly string[]): boolean {
    return expectedValues.some((expected) => this.isMatchingWebhookSecret(provided, expected));
  }

  private isMatchingWebhookSecret(provided: string, expected: string): boolean {
    const providedBuffer = Buffer.from(provided);
    const expectedBuffer = Buffer.from(expected);
    return (
      providedBuffer.length === expectedBuffer.length &&
      timingSafeEqual(providedBuffer, expectedBuffer)
    );
  }
}
