import { Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxActionDispatchOptions,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import {
  ManagedEntityAccessLossService,
  classifyMaxTerminalChatActionError,
  resolveManagedEntityAccessLossReason,
} from '../max/managed-entity-access-loss.service';
import { MaxRoutedPublicationService } from '../max/max-routed-publication.service';
import {
  buildNightModeClosedNotice,
  buildNightModeOpenedNotice,
  type NightModeBotSpeechProfile,
} from './night-mode-transition-notice.util';
import {
  NIGHT_MODE_TRANSITION_PROCESS_CONTINUE,
  NIGHT_MODE_TRANSITION_PROCESS_STOP,
  type NightModeTransitionProcessResult,
} from './night-mode-transition.queue';
import type {
  NightModeTransitionNoticeResult,
  NightModeTransitionRuntimeHooks,
  NightModeTransitionRuntimeSettings,
} from './night-mode-transition-runtime.service';
import { BotSpeechMediaService } from './bot-speech-media.service';
import {
  NightModeTransitionEventService,
  type NightModeTransitionEventParams,
} from './night-mode-transition-event.service';
import { NightModeTransitionNoticeEventPersistenceError } from './night-mode-transition-notice-persistence-error';

export type NightModeTransitionDeliveryOperation =
  | 'send-close-notice'
  | 'send-open-notice'
  | 'delete-close-notice';

export type NightModeTransitionDeliverySnapshot = {
  startMinutes: number;
  endMinutes: number;
  timezone: string;
  sessionKey: string;
};

export type NightModeTransitionDeliveryAdapters = {
  getBotSpeechProfile(botId?: string | null): NightModeBotSpeechProfile;
  buildClosedNoticeOptions(
    settings: NightModeTransitionRuntimeSettings,
  ): MaxSendMessageOptions | null;
  resolveBotId(chatId: string): Promise<string | null>;
};

@Injectable()
export class NightModeTransitionDeliveryService {
  private readonly logger = new Logger(NightModeTransitionDeliveryService.name);

  constructor(
    private readonly maxClient: MaxClientService,
    private readonly botSpeechMediaService: BotSpeechMediaService,
    private readonly nightModeTransitionEventService: NightModeTransitionEventService,
    @Optional()
    private readonly managedEntityAccessLossService?: ManagedEntityAccessLossService,
    @Optional()
    private readonly maxRoutedPublicationService?: MaxRoutedPublicationService,
  ) {}

  createHooks(adapters: NightModeTransitionDeliveryAdapters): NightModeTransitionRuntimeHooks {
    return {
      sendClosedNotice: (settings, snapshot) => this.sendClosedNotice(settings, snapshot, adapters),
      sendOpenedNotice: (settings, snapshot) => this.sendOpenedNotice(settings, snapshot, adapters),
      deleteClosedNotice: (chatId, messageId) =>
        this.deleteClosedNotice(chatId, messageId, adapters),
    };
  }

  async sendClosedNotice(
    settings: NightModeTransitionRuntimeSettings,
    snapshot: NightModeTransitionDeliverySnapshot,
    adapters: NightModeTransitionDeliveryAdapters,
  ): Promise<NightModeTransitionNoticeResult> {
    const buildMessageText = (botId?: string | null) =>
      buildNightModeClosedNotice({
        startMinutes: snapshot.startMinutes,
        endMinutes: snapshot.endMinutes,
        timezone: snapshot.timezone,
        templateText: settings.nightModeBotMessageText,
        botSpeechStyle: settings.botSpeechStyle,
        activeBotSpeechProfile: adapters.getBotSpeechProfile(botId),
      });
    const messageOptions = adapters.buildClosedNoticeOptions(settings);

    let sent: { messageId: string | null };
    let attemptedBotId: string | null = null;
    try {
      sent = await this.sendNotice({
        chatId: settings.chatId,
        logicalIdempotencyKey: this.buildNoticeIdempotencyKey(
          'close',
          settings.chatId,
          snapshot.sessionKey,
        ),
        messageText: buildMessageText(),
        resolveMessageText: buildMessageText,
        messageOptions,
        mediaSettings: settings,
        mediaFieldKey: 'nightModeBotMessageText',
        adapters,
        onDispatchAttempt: (botId) => {
          attemptedBotId = botId;
        },
      });
    } catch (error: unknown) {
      const terminalResult = await this.handleTerminalError({
        chatId: settings.chatId,
        botId: attemptedBotId,
        operation: 'send-close-notice',
        error,
      });
      if (terminalResult) {
        return {
          ...terminalResult,
          messageId: null,
        };
      }
      throw error;
    }

    await this.createEventAfterAcceptedNotice({
      chatId: settings.chatId,
      messageId: sent.messageId,
      ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
      sessionKey: snapshot.sessionKey,
      timezone: snapshot.timezone,
      startMinutes: snapshot.startMinutes,
      endMinutes: snapshot.endMinutes,
    });

    return {
      ...NIGHT_MODE_TRANSITION_PROCESS_CONTINUE,
      messageId: sent.messageId,
    };
  }

  async sendOpenedNotice(
    settings: Pick<
      NightModeTransitionRuntimeSettings,
      'chatId' | 'nightModeOpenMessageText' | 'botSpeechStyle' | 'botSpeechMedia'
    >,
    snapshot: NightModeTransitionDeliverySnapshot,
    adapters: NightModeTransitionDeliveryAdapters,
  ): Promise<NightModeTransitionProcessResult> {
    const buildMessageText = (botId?: string | null) =>
      buildNightModeOpenedNotice({
        startMinutes: snapshot.startMinutes,
        endMinutes: snapshot.endMinutes,
        timezone: snapshot.timezone,
        templateText: settings.nightModeOpenMessageText,
        botSpeechStyle: settings.botSpeechStyle,
        activeBotSpeechProfile: adapters.getBotSpeechProfile(botId),
      });
    let sent: { messageId: string | null };
    let attemptedBotId: string | null = null;
    try {
      sent = await this.sendNotice({
        chatId: settings.chatId,
        logicalIdempotencyKey: this.buildNoticeIdempotencyKey(
          'open',
          settings.chatId,
          snapshot.sessionKey,
        ),
        messageText: buildMessageText(),
        resolveMessageText: buildMessageText,
        messageOptions: undefined,
        mediaSettings: settings,
        mediaFieldKey: 'nightModeOpenMessageText',
        adapters,
        onDispatchAttempt: (botId) => {
          attemptedBotId = botId;
        },
      });
    } catch (error: unknown) {
      const terminalResult = await this.handleTerminalError({
        chatId: settings.chatId,
        botId: attemptedBotId,
        operation: 'send-open-notice',
        error,
      });
      if (terminalResult) {
        return terminalResult;
      }
      throw error;
    }

    await this.createEventAfterAcceptedNotice({
      chatId: settings.chatId,
      messageId: sent.messageId,
      ruleCode: 'NIGHT_MODE_OPEN_NOTICE',
      sessionKey: snapshot.sessionKey,
      timezone: snapshot.timezone,
      startMinutes: snapshot.startMinutes,
      endMinutes: snapshot.endMinutes,
    });
    return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
  }

  private async sendNotice(params: {
    chatId: string;
    logicalIdempotencyKey: string;
    messageText: string;
    resolveMessageText?: (botId: string | null) => string;
    messageOptions: MaxSendMessageOptions | null | undefined;
    mediaSettings: { botSpeechMedia?: unknown };
    mediaFieldKey: 'nightModeBotMessageText' | 'nightModeOpenMessageText';
    adapters: NightModeTransitionDeliveryAdapters;
    onDispatchAttempt: (botId: string | null) => void;
  }): Promise<{ messageId: string | null }> {
    const baseOptions = this.withMarkdownMessageOptions(params.messageOptions ?? null);
    const media = this.botSpeechMediaService.resolveMedia(
      params.mediaSettings,
      params.mediaFieldKey,
    );
    if (!this.maxRoutedPublicationService && process.env.NODE_ENV === 'production') {
      throw new ServiceUnavailableException(
        'Routed MAX publication service is required for production night mode notices',
      );
    }
    if (this.maxRoutedPublicationService) {
      return this.maxRoutedPublicationService.publish({
        entityId: params.chatId,
        logicalIdempotencyKey: params.logicalIdempotencyKey,
        text: params.messageText,
        options: baseOptions,
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.NIGHT_MODE_TRANSITION,
        ignoreFailureMetricStatuses: [403, 404],
        prepareAttempt: async ({ botId }) => ({
          text: params.resolveMessageText?.(botId) ?? params.messageText,
          options: await this.botSpeechMediaService.withMediaOptions(baseOptions, media, {
            botId,
            sourceTag: MAX_API_SOURCE_TAGS.NIGHT_MODE_TRANSITION,
          }),
        }),
        onDispatchAttempt: ({ botId }) => {
          params.onDispatchAttempt(botId);
        },
      });
    }

    const botId = await params.adapters.resolveBotId(params.chatId);
    params.onDispatchAttempt(botId);
    const messageOptionsWithMedia = await this.botSpeechMediaService.withMediaOptions(
      baseOptions,
      media,
      { botId, sourceTag: MAX_API_SOURCE_TAGS.NIGHT_MODE_TRANSITION },
    );
    return this.maxClient.sendMessageImmediateWithId(
      params.chatId,
      params.resolveMessageText?.(botId) ?? params.messageText,
      messageOptionsWithMedia,
      this.buildRequestOptions(botId),
    );
  }

  private buildNoticeIdempotencyKey(
    transition: 'close' | 'open',
    chatId: string,
    sessionKey: string,
  ): string {
    return `night-mode:${transition}:${chatId}:session:${sessionKey}`;
  }

  private async createEvent(params: NightModeTransitionEventParams): Promise<void> {
    await this.nightModeTransitionEventService.createTransitionEvent(params);
  }

  private async createEventAfterAcceptedNotice(
    params: NightModeTransitionEventParams,
  ): Promise<void> {
    try {
      await this.createEvent(params);
    } catch (error: unknown) {
      const messageId = params.messageId?.trim() ?? '';
      if (messageId) {
        throw new NightModeTransitionNoticeEventPersistenceError(
          {
            ...params,
            messageId,
          },
          error,
        );
      }
      throw error;
    }
  }

  async deleteClosedNotice(
    chatId: string,
    messageId: string,
    adapters: NightModeTransitionDeliveryAdapters,
  ): Promise<NightModeTransitionProcessResult> {
    const botId = await adapters.resolveBotId(chatId);
    try {
      await this.maxClient.deleteMessage(chatId, messageId, {
        immediate: true,
        ...this.buildRequestOptions(botId),
      });
    } catch (error: unknown) {
      const terminalResult = await this.handleTerminalError({
        chatId,
        botId,
        messageId,
        operation: 'delete-close-notice',
        error,
      });
      if (terminalResult) {
        return terminalResult;
      }
      throw error;
    }
    return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
  }

  private async handleTerminalError(params: {
    chatId: string;
    botId: string | null;
    messageId?: string;
    operation: NightModeTransitionDeliveryOperation;
    error: unknown;
  }): Promise<NightModeTransitionProcessResult | null> {
    const classification = classifyMaxTerminalChatActionError(params.error);
    if (!classification) {
      return null;
    }

    this.logTerminalError(params);
    const accessLossReason = resolveManagedEntityAccessLossReason(
      this.mapOperation(params.operation),
      classification,
    );
    if (!accessLossReason) {
      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    }

    await this.managedEntityAccessLossService?.recordManagedEntityAccessLost({
      chatId: params.chatId,
      botId: params.botId,
      reason: accessLossReason,
      source: `night_mode_transition:${params.operation}`,
      lastMaxErrorCode: classification.code,
      lastMaxErrorMessage: classification.message,
      lastMaxStatusCode: classification.statusCode,
    });
    return NIGHT_MODE_TRANSITION_PROCESS_STOP;
  }

  private mapOperation(operation: NightModeTransitionDeliveryOperation): 'send' | 'delete' {
    return operation === 'delete-close-notice' ? 'delete' : 'send';
  }

  private logTerminalError(params: {
    chatId: string;
    messageId?: string;
    operation: NightModeTransitionDeliveryOperation;
    error: unknown;
  }): void {
    this.logger.debug(
      {
        chatId: params.chatId,
        ...(params.messageId ? { messageId: params.messageId } : {}),
        operation: params.operation,
        status: this.extractStatusCode(params.error),
        code: this.extractMaxErrorCode(params.error),
        error: params.error instanceof Error ? params.error.message : String(params.error),
      },
      'Skipped terminal night mode transition action',
    );
  }

  private buildRequestOptions(botId: string | null): MaxActionDispatchOptions {
    return {
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: MAX_API_SOURCE_TAGS.NIGHT_MODE_TRANSITION,
      ignoreFailureMetricStatuses: [403, 404],
      ...(botId ? { botId } : {}),
    };
  }

  private withMarkdownMessageOptions(options: MaxSendMessageOptions | null): MaxSendMessageOptions {
    return {
      ...(options ?? {}),
      textFormat: 'markdown',
    };
  }

  private extractStatusCode(error: unknown): number | null {
    const maybeResponse = (error as { response?: { status?: unknown }; status?: unknown }) ?? {};
    const status = maybeResponse.response?.status ?? maybeResponse.status;
    return typeof status === 'number' ? status : null;
  }

  private extractMaxErrorCode(error: unknown): string | null {
    const data = (error as { response?: { data?: unknown } })?.response?.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const code = (data as Record<string, unknown>).code;
      return typeof code === 'string' && code.trim().length > 0 ? code.trim() : null;
    }
    return null;
  }
}
