import { parseArgs, renderText, runFixtureSmoke } from './smoke-multi-bot-routes';

describe('smoke-multi-bot-routes', () => {
  it('parses fixture, db, json, and chat id flags', () => {
    expect(parseArgs(['--json'])).toEqual({
      json: true,
      mode: 'fixture',
      chatId: null,
    });
    expect(parseArgs(['--db', '--chat-id', 'chat-1'])).toEqual({
      json: false,
      mode: 'db',
      chatId: 'chat-1',
    });
    expect(parseArgs(['--db', '--chat-id=chat-2'])).toEqual({
      json: false,
      mode: 'db',
      chatId: 'chat-2',
    });
    expect(() => parseArgs(['--db'])).toThrow('--db requires --chat-id <chat-id>');
  });

  it('passes the deterministic 1/2/3/6 fixture route matrix', async () => {
    const result = await runFixtureSmoke();

    expect(result.status).toBe('PASS');
    expect(result.scenarios.map((scenario) => scenario.name)).toEqual(
      expect.arrayContaining([
        'matrix-1',
        'matrix-2',
        'matrix-3',
        'matrix-6',
        'channel-delete-permission',
      ]),
    );
    expect(
      result.scenarios
        .find((scenario) => scenario.name === 'channel-delete-permission')
        ?.routes.find(
          (route) => route.purpose === 'moderation_action' && route.action === 'delete_message',
        ),
    ).toEqual(
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        candidateBotIds: ['id613002203036_4_bot'],
      }),
    );
    expect(result.assertions.every((assertion) => assertion.pass)).toBe(true);
    expect(renderText(result)).toContain('Multi-bot route smoke: PASS');
  });
});
