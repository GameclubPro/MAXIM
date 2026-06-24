import { BotSpeechMediaService } from './bot-speech-media.service';

describe('BotSpeechMediaService', () => {
  it('resolves configured image media and trims values', () => {
    const service = new BotSpeechMediaService({} as never);

    expect(
      service.resolveMedia(
        {
          botSpeechMedia: {
            nightModeBotMessageText: {
              base64: ' aW1hZ2U= ',
              mimeType: ' image/png ',
              fileName: ' night.png ',
            },
          },
        },
        'nightModeBotMessageText',
      ),
    ).toEqual({
      base64: 'aW1hZ2U=',
      mimeType: 'image/png',
      fileName: 'night.png',
      fieldKey: 'nightModeBotMessageText',
    });
  });

  it('uses the legacy default filename when a configured image has no file name', () => {
    const service = new BotSpeechMediaService({} as never);

    expect(
      service.resolveMedia(
        {
          botSpeechMedia: {
            messageLimitsBotMessageText: {
              base64: 'aW1hZ2U=',
              mimeType: 'image/jpeg',
              fileName: '   ',
            },
          },
        },
        'messageLimitsBotMessageText',
      ),
    ).toEqual({
      base64: 'aW1hZ2U=',
      mimeType: 'image/jpeg',
      fileName: 'bot-message-image.jpg',
      fieldKey: 'messageLimitsBotMessageText',
    });
  });

  it('ignores missing field keys, invalid records, empty payloads, and non-image mime types', () => {
    const service = new BotSpeechMediaService({} as never);

    expect(service.resolveMedia({ botSpeechMedia: {} })).toBeNull();
    expect(service.resolveMedia({ botSpeechMedia: [] }, 'nightModeBotMessageText')).toBeNull();
    expect(
      service.resolveMedia(
        {
          botSpeechMedia: {
            nightModeBotMessageText: {
              base64: '',
              mimeType: 'image/png',
            },
          },
        },
        'nightModeBotMessageText',
      ),
    ).toBeNull();
    expect(
      service.resolveMedia(
        {
          botSpeechMedia: {
            nightModeBotMessageText: {
              base64: 'aW1hZ2U=',
              mimeType: 'text/plain',
            },
          },
        },
        'nightModeBotMessageText',
      ),
    ).toBeNull();
  });

  it('uploads media with background moderation defaults and attaches the image payload', async () => {
    const maxClient = {
      uploadImage: jest.fn().mockResolvedValue({ token: 'image-token' }),
    };
    const service = new BotSpeechMediaService(maxClient as never);
    const media = {
      base64: Buffer.from('image-bytes').toString('base64'),
      mimeType: 'image/png',
      fileName: 'notice.png',
      fieldKey: 'messageLimitsBotMessageText' as const,
    };

    await expect(
      service.withMediaOptions(
        {
          textFormat: 'html',
        },
        media,
      ),
    ).resolves.toEqual({
      textFormat: 'html',
      imagePayload: { token: 'image-token' },
    });

    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      Buffer.from('image-bytes'),
      'notice.png',
      'image/png',
      {
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'moderation_notice',
      },
    );
  });

  it('passes explicit upload lanes, source tag, and bot id to MAX uploads', async () => {
    const maxClient = {
      uploadImage: jest.fn().mockResolvedValue({ token: 'image-token' }),
    };
    const service = new BotSpeechMediaService(maxClient as never);

    await service.withMediaOptions(
      undefined,
      {
        base64: Buffer.from('image-bytes').toString('base64'),
        mimeType: 'image/png',
        fileName: 'night.png',
        fieldKey: 'nightModeOpenMessageText',
      },
      {
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: 'night_mode_transition',
        botId: 'bot-1',
      },
    );

    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      Buffer.from('image-bytes'),
      'night.png',
      'image/png',
      {
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: 'night_mode_transition',
        botId: 'bot-1',
      },
    );
  });

  it('keeps original options when upload fails', async () => {
    const maxClient = {
      uploadImage: jest.fn().mockRejectedValue(new Error('upload failed')),
    };
    const service = new BotSpeechMediaService(maxClient as never);
    const loggerSpy = jest
      .spyOn((service as never as { logger: { warn: jest.Mock } }).logger, 'warn')
      .mockImplementation(jest.fn());
    const options = {
      textFormat: 'markdown' as const,
    };

    await expect(
      service.withMediaOptions(options, {
        base64: 'aW1hZ2U=',
        mimeType: 'image/png',
        fileName: 'notice.png',
        fieldKey: 'nightModeBotMessageText',
      }),
    ).resolves.toBe(options);

    expect(loggerSpy).toHaveBeenCalledWith(
      {
        fieldKey: 'nightModeBotMessageText',
        error: 'upload failed',
      },
      'Failed to upload bot speech image; sending text-only notice',
    );
  });
});
