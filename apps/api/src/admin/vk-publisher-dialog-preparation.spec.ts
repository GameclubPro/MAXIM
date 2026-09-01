import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublisherDialogLinkService } from '../publisher/publisher-dialog-link.service';
import { PublisherDialogSigningKeyService } from '../publisher/publisher-dialog-signing-key.service';
import { PublisherDialogContextService } from './publisher-dialog-context.service';

describe('VK Publisher dialog preparation on api-action', () => {
  const previousServiceName = process.env.APP_SERVICE_NAME;
  let directory: string;

  beforeEach(() => {
    process.env.APP_SERVICE_NAME = 'api-action';
    directory = mkdtempSync(join(tmpdir(), 'maxim-publisher-dialog-'));
  });

  afterEach(() => {
    if (previousServiceName === undefined) {
      delete process.env.APP_SERVICE_NAME;
    } else {
      process.env.APP_SERVICE_NAME = previousServiceName;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it('signs an enabled Publisher suggestion module without bot or init-data credentials', async () => {
    const keyFile = join(directory, 'dialog-signing.json');
    writeFileSync(
      keyFile,
      JSON.stringify({
        version: 1,
        botId: 'publisher-bot',
        keys: [Buffer.alloc(32, 7).toString('base64')],
      }),
      { mode: 0o600 },
    );
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'MAX_PUBLISHER_BOT_ID') return 'publisher-bot';
        if (key === 'MAX_PUBLISHER_DIALOG_SIGNING_KEY_FILE') return keyFile;
        return undefined;
      }),
    };
    const signingKeys = new PublisherDialogSigningKeyService(config as never);
    const dialogLinks = new PublisherDialogLinkService(config as never, signingKeys);
    const contextService = new PublisherDialogContextService(
      {
        publisherEntitySettings: {
          upsert: jest.fn().mockResolvedValue({
            channelCommentsEnabled: true,
            channelSuggestionsEnabled: true,
          }),
        },
      } as never,
      dialogLinks,
    );

    const context = await contextService.prepare({
      chatId: 'channel-publisher-only',
      entityType: 'channel',
      dialogBotId: 'publisher-bot',
      customButtons: [],
    });

    expect(context.reference).toEqual(
      expect.objectContaining({
        entityType: 'channel',
        includeCommentsButton: true,
        includeSuggestButton: true,
        dialogBotId: 'publisher-bot',
      }),
    );
    const commentsButton = context.buttons[0]?.[0];
    const suggestButton = context.buttons[1]?.[0];
    expect(commentsButton).toEqual(
      expect.objectContaining({
        type: 'link',
        url: expect.stringMatching(/^https:\/\/max\.ru\/publisher-bot\?startapp=/u),
      }),
    );
    expect(suggestButton).toEqual(
      expect.objectContaining({
        type: 'link',
        url: expect.stringMatching(/^https:\/\/max\.ru\/publisher-bot\?startapp=/u),
      }),
    );

    const commentsStartParam = new URL((commentsButton as { url: string }).url).searchParams.get(
      'startapp',
    )!;
    const commentsPayload = JSON.parse(
      Buffer.from(commentsStartParam.slice('cd-'.length), 'base64url').toString('utf8'),
    ) as { t: string };
    expect(
      dialogLinks.resolveChannelDialogThreadId(
        'channel-publisher-only',
        'comments',
        commentsPayload.t,
      ),
    ).toBe(context.reference?.threadId);
    const suggestStartParam = new URL((suggestButton as { url: string }).url).searchParams.get(
      'startapp',
    )!;
    const suggestPayload = JSON.parse(
      Buffer.from(suggestStartParam.slice('cd-'.length), 'base64url').toString('utf8'),
    ) as { t: string };
    expect(
      dialogLinks.resolveChannelDialogThreadId(
        'channel-publisher-only',
        'suggest',
        suggestPayload.t,
      ),
    ).toBe(context.reference?.threadId);
  });
});
