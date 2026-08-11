import {
  adaptMaxMessageNavigationView,
  adaptMaxWebhookNavigationView,
} from './max-navigation-view.adapter';
import { extractClientClickableTextEvidence } from './client-clickable-text.extractor';
import { extractNavigationEvidence } from './navigation-evidence.extractor';
import {
  INCIDENT_EXTERNAL_FORWARD_FIXTURE,
  INCIDENT_EXTERNAL_URL,
  INCIDENT_PROFILE_MENTION_FORWARD_FIXTURE,
} from './navigation-evidence.fixtures';

describe('navigation evidence extractor', () => {
  it('deduplicates the incident external forward while retaining markup and share origins', () => {
    const result = extractNavigationEvidence(
      adaptMaxMessageNavigationView(INCIDENT_EXTERNAL_FORWARD_FIXTURE),
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toEqual(
      expect.objectContaining({
        kind: 'external_url',
        target: INCIDENT_EXTERNAL_URL,
        normalizedTarget: INCIDENT_EXTERNAL_URL,
        enforceable: true,
      }),
    );
    expect(result.targets[0].origins.map((origin) => origin.carrier)).toEqual([
      'link_markup',
      'share_attachment',
    ]);
    expect(result.targets[0].origins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provenance: 'visible_forward',
          certainty: 'platform_declared',
          enforcement: 'eligible',
          range: expect.objectContaining({ status: 'valid', visibleText: INCIDENT_EXTERNAL_URL }),
        }),
        expect.objectContaining({
          provenance: 'visible_forward',
          certainty: 'platform_declared',
          enforcement: 'eligible',
          range: expect.objectContaining({ status: 'not_applicable' }),
        }),
      ]),
    );
    expect(
      result.targets[0].origins.every((origin) =>
        /^[a-f0-9]{64}$/u.test(origin.contentFingerprint),
      ),
    ).toBe(true);
    expect(new Set(result.targets[0].origins.map((origin) => origin.contentFingerprint)).size).toBe(
      1,
    );
  });

  it('classifies the second incident as a MAX profile mention, not an external URL', () => {
    const result = extractNavigationEvidence(
      adaptMaxMessageNavigationView(INCIDENT_PROFILE_MENTION_FORWARD_FIXTURE),
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.targets).toEqual([
      expect.objectContaining({
        kind: 'profile_mention',
        target: 'max://user/67123224',
        normalizedTarget: 'max://user/67123224',
        enforceable: true,
        origins: [
          expect.objectContaining({
            carrier: 'user_mention_markup',
            provenance: 'visible_forward',
            range: expect.objectContaining({ status: 'valid' }),
          }),
        ],
      }),
    ]);
    expect(result.targets.some((target) => target.kind === 'external_url')).toBe(false);
  });

  it('extracts direct and visible-forward content but stops at reply quotes', () => {
    const directAndForward = extractNavigationEvidence(
      adaptMaxMessageNavigationView({
        body: {
          text: 'Сайт',
          markup: [
            {
              type: 'link',
              from: 0,
              length: 4,
              url: 'https://direct.example/path',
            },
          ],
        },
        link: {
          type: 'forward',
          message: {
            text: 'Канал',
            markup: [
              {
                type: 'link',
                from: 0,
                length: 5,
                url: 'https://forward.example/path',
              },
            ],
          },
        },
      }),
    );

    expect(directAndForward.targets.map((target) => target.target)).toEqual([
      'https://direct.example/path',
      'https://forward.example/path',
    ]);
    expect(directAndForward.targets.map((target) => target.origins[0].provenance)).toEqual([
      'direct',
      'visible_forward',
    ]);

    const replyView = adaptMaxMessageNavigationView({
      body: { text: 'Ответ без ссылки' },
      link: {
        type: 'reply',
        message: {
          text: 'Quoted link',
          markup: [
            {
              type: 'link',
              from: 0,
              length: 11,
              url: 'https://quoted.example/path',
            },
          ],
          attachments: [
            { type: 'share', payload: { url: 'https://quoted-share.example/path' } },
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [[{ type: 'link', url: 'https://quoted-button.example/path' }]],
              },
            },
          ],
        },
      },
    });

    expect(replyView.replyStopped).toBe(true);
    expect(extractNavigationEvidence(replyView)).toEqual({ targets: [], diagnostics: [] });
  });

  it('extracts link and open-app buttons through typed keyboard paths only', () => {
    const result = extractNavigationEvidence(
      adaptMaxMessageNavigationView({
        body: {
          text: 'Действия',
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [{ type: 'link', text: 'Web', url: 'https://button.example/path' }],
                  [
                    {
                      type: 'open_app',
                      text: 'App',
                      web_app: 'https://major-maksimov.ru/app/',
                      contact_id: 613002203036,
                    },
                  ],
                  [
                    {
                      type: 'callback',
                      text: 'Metadata',
                      payload: 'https://callback-metadata.example/path',
                      url: 'https://ignored-callback.example/path',
                    },
                  ],
                ],
              },
            },
          ],
        },
      }),
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.targets.map(({ kind, target }) => ({ kind, target }))).toEqual([
      { kind: 'external_url', target: 'https://button.example/path' },
      { kind: 'mini_app', target: 'https://major-maksimov.ru/app/' },
    ]);
    expect(result.targets[1]).toEqual(
      expect.objectContaining({
        allowlistAliases: [
          {
            kind: 'mini_app',
            target: 'contact_id:613002203036',
            normalizedTarget: 'contact_id:613002203036',
          },
        ],
      }),
    );
    expect(result.targets.map((target) => target.origins.map((origin) => origin.carrier))).toEqual([
      ['link_button'],
      ['open_app_button', 'open_app_button'],
    ]);
  });

  it('keeps valid inbound HTTP targets whose paths contain nested scheme text', () => {
    const nestedScheme = 'https://redirect.example/path/https://target.example';
    const encodedScheme = 'https://redirect.example/path/https%3A%2F%2Ftarget.example';
    const result = extractNavigationEvidence(
      adaptMaxMessageNavigationView({
        body: {
          text: 'Label',
          markup: [{ type: 'link', from: 0, length: 5, url: nestedScheme }],
          attachments: [
            { type: 'share', payload: { url: encodedScheme } },
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [{ type: 'link', url: `${nestedScheme}?button=1` }],
                  [{ type: 'open_app', web_app: `${encodedScheme}?app=1` }],
                ],
              },
            },
          ],
        },
      }),
      {
        plainTextCandidates: [
          {
            target: `${nestedScheme}?plain=1`,
            provenance: 'direct',
            from: 0,
            length: 5,
          },
        ],
      },
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.targets.map((target) => target.target)).toEqual([
      nestedScheme,
      encodedScheme,
      `${nestedScheme}?button=1`,
      `${encodedScheme}?app=1`,
      `${nestedScheme}?plain=1`,
    ]);
    expect(result.targets.map((target) => target.origins[0]?.carrier)).toEqual([
      'link_markup',
      'share_attachment',
      'link_button',
      'open_app_button',
      'plain_text',
    ]);
    expect(result.targets.every((target) => target.enforceable)).toBe(true);
  });

  it('extracts the official open-app public bot username form', () => {
    const result = extractNavigationEvidence(
      adaptMaxMessageNavigationView({
        body: {
          text: 'App',
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [[{ type: 'open_app', text: 'Open', web_app: 'Some_Public_Bot' }]],
              },
            },
          ],
        },
      }),
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.targets).toEqual([
      expect.objectContaining({
        kind: 'mini_app',
        target: 'bot:some_public_bot',
        enforceable: true,
      }),
    ]);
  });

  it('links the official open-app bot URL to the same username allowlist identity', () => {
    const result = extractNavigationEvidence(
      adaptMaxMessageNavigationView({
        body: {
          text: 'App',
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [{ type: 'open_app', text: 'Open', web_app: 'https://max.ru/Some_Public_Bot' }],
                ],
              },
            },
          ],
        },
      }),
    );

    expect(result.targets).toEqual([
      expect.objectContaining({
        kind: 'mini_app',
        target: 'https://max.ru/Some_Public_Bot',
        allowlistAliases: [
          expect.objectContaining({ kind: 'mini_app', target: 'bot:some_public_bot' }),
        ],
      }),
    ]);
  });

  it('does not alias reserved MAX routes to mini-app bot identities', () => {
    const result = extractNavigationEvidence(
      adaptMaxMessageNavigationView({
        body: {
          text: 'App',
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [[{ type: 'open_app', web_app: 'https://max.ru/join' }]],
              },
            },
          ],
        },
      }),
    );

    expect(result.targets).toEqual([expect.objectContaining({ target: 'https://max.ru/join' })]);
    expect(result.targets[0]?.allowlistAliases).toBeUndefined();
  });

  it('keeps separate open-app actions when buttons share a URL but have different contacts', () => {
    const result = extractNavigationEvidence(
      adaptMaxMessageNavigationView({
        body: {
          text: 'Apps',
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'open_app',
                      web_app: 'https://apps.example/start',
                      contact_id: 101,
                    },
                    {
                      type: 'open_app',
                      web_app: 'https://apps.example/start',
                      contact_id: 202,
                    },
                  ],
                ],
              },
            },
          ],
        },
      }),
    );

    expect(result.targets).toHaveLength(2);
    expect(result.targets.map((target) => target.allowlistAliases?.[0]?.target)).toEqual([
      'contact_id:101',
      'contact_id:202',
    ]);
  });

  it('enforces chat creation buttons and recognizes message buttons as non-navigation', () => {
    const result = extractNavigationEvidence(
      adaptMaxMessageNavigationView({
        body: {
          text: 'Actions',
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [{ type: 'chat', chat_title: 'New chat', uuid: 987654 }],
                  [{ type: 'chat', chat_title: 'Another chat' }],
                  [{ type: 'message', text: 'Send this text' }],
                ],
              },
            },
          ],
        },
      }),
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.targets).toEqual([
      expect.objectContaining({
        kind: 'max_entity',
        target: 'chat_uuid:987654',
        enforceable: true,
      }),
      expect.objectContaining({
        kind: 'max_entity',
        target: 'chat-create',
        enforceable: true,
      }),
    ]);
    expect(result.targets.every((target) => target.origins[0]?.carrier === 'chat_button')).toBe(
      true,
    );
  });

  it('classifies startapp before generic and MAX entity web URLs', () => {
    const result = extractNavigationEvidence(
      adaptMaxMessageNavigationView({
        body: {
          text: 'Routes',
          attachments: [
            { type: 'share', payload: { url: 'https://max.ru/join/abc' } },
            { type: 'share', payload: { url: 'https://max.ru/bot?startapp=comments' } },
            { type: 'share', payload: { url: 'https://max.ru/join/abc?startapp=tracking' } },
            { type: 'share', payload: { url: 'https://max.ru/bot?startapp=' } },
            { type: 'share', payload: { url: 'https://max.ru/join?startapp=tracking' } },
            { type: 'share', payload: { url: 'https://max.ru/bot?startapp=bad%2Fpayload' } },
            { type: 'share', payload: { url: `https://max.ru/bot?startapp=${'a'.repeat(513)}` } },
            {
              type: 'share',
              payload: { url: 'https://max.ru/bot?startapp=one&startapp=two' },
            },
            { type: 'share', payload: { url: 'https://dev.max.ru/docs-api' } },
          ],
        },
      }),
    );

    expect(result.targets.map(({ kind, target }) => ({ kind, target }))).toEqual([
      { kind: 'external_url', target: 'https://max.ru/join/abc' },
      { kind: 'mini_app', target: 'https://max.ru/bot?startapp=comments' },
      { kind: 'external_url', target: 'https://max.ru/join/abc?startapp=tracking' },
      { kind: 'external_url', target: 'https://max.ru/bot?startapp=' },
      { kind: 'external_url', target: 'https://max.ru/join?startapp=tracking' },
      { kind: 'external_url', target: 'https://max.ru/bot?startapp=bad%2Fpayload' },
      { kind: 'external_url', target: `https://max.ru/bot?startapp=${'a'.repeat(513)}` },
      { kind: 'external_url', target: 'https://max.ru/bot?startapp=one&startapp=two' },
      { kind: 'external_url', target: 'https://dev.max.ru/docs-api' },
    ]);
  });

  it('accepts the complete 512-character official startapp payload boundary', () => {
    const target = `https://max.ru/entry-bot?startapp=${'a'.repeat(512)}`;
    const result = extractNavigationEvidence(
      adaptMaxMessageNavigationView({
        body: { text: 'App', attachments: [{ type: 'share', payload: { url: target } }] },
      }),
    );

    expect(result.targets).toEqual([
      expect.objectContaining({ kind: 'mini_app', target, enforceable: true }),
    ]);
  });

  it('never mines plain text, media payloads, forward headers, or arbitrary metadata', () => {
    const result = extractNavigationEvidence(
      adaptMaxMessageNavigationView({
        url: 'https://post-metadata.example/path',
        sender: { avatar_url: 'https://sender-metadata.example/avatar' },
        body: {
          text: 'Visible but unverified https://plain.example/path',
          metadata: { url: 'https://body-metadata.example/path' },
          attachments: [
            {
              type: 'image',
              image_url: 'https://image-metadata.example/path',
              payload: { url: 'https://image-payload.example/path' },
            },
            {
              type: 'file',
              filename: 'https://filename-metadata.example/path',
              payload: { url: 'https://file-payload.example/path' },
            },
            {
              type: 'share',
              title: 'https://share-title.example/path',
              description: 'https://share-description.example/path',
              payload: { token: 'share-without-url' },
            },
          ],
        },
        link: {
          type: 'forward',
          sender: { url: 'https://forward-sender.example/path' },
          chat: { link: 'https://forward-chat.example/path' },
          message: {
            text: 'No structured target https://forward-plain.example/path',
            metadata: { href: 'https://forward-metadata.example/path' },
          },
        },
      }),
    );

    expect(result).toEqual({ targets: [], diagnostics: [] });
  });

  it('requires explicit text-link candidates before plain text becomes evidence', () => {
    const text = 'Открыть https://plain.example/path';
    const view = adaptMaxMessageNavigationView({ body: { text } });

    expect(extractNavigationEvidence(view).targets).toEqual([]);

    const result = extractNavigationEvidence(view, {
      plainTextCandidates: [
        {
          provenance: 'direct',
          target: 'https://plain.example/path',
          from: text.indexOf('https://'),
          length: 'https://plain.example/path'.length,
        },
      ],
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.targets).toEqual([
      expect.objectContaining({
        kind: 'external_url',
        enforceable: true,
        origins: [
          expect.objectContaining({
            carrier: 'plain_text',
            certainty: 'text_inferred',
            enforcement: 'eligible',
            range: expect.objectContaining({ status: 'valid' }),
          }),
        ],
      }),
    ]);
  });

  it('accepts normalized client evidence for a clickable bare-domain link', () => {
    const text = 'Join max.ru/join/abc';
    const view = adaptMaxMessageNavigationView({ body: { text } });

    const result = extractNavigationEvidence(view, {
      plainTextCandidates: extractClientClickableTextEvidence(view),
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.targets).toEqual([
      expect.objectContaining({
        kind: 'external_url',
        target: 'https://max.ru/join/abc',
        normalizedTarget: 'https://max.ru/join/abc',
        enforceable: true,
        origins: [
          expect.objectContaining({
            carrier: 'plain_text',
            certainty: 'text_inferred',
            enforcement: 'eligible',
            range: expect.objectContaining({
              status: 'valid',
              from: text.indexOf('max.ru'),
              length: 'max.ru/join/abc'.length,
              visibleText: 'max.ru/join/abc',
            }),
          }),
        ],
      }),
    ]);
  });

  it('validates UTF-16 ranges and keeps malformed markup shadow-only', () => {
    const result = extractNavigationEvidence(
      adaptMaxMessageNavigationView({
        body: {
          text: '😀сайт',
          markup: [
            {
              type: 'link',
              from: 1,
              length: 5,
              url: 'https://shadow.example/path',
            },
          ],
        },
      }),
    );

    expect(result.targets).toEqual([
      expect.objectContaining({
        target: 'https://shadow.example/path',
        enforceable: false,
        origins: [
          expect.objectContaining({
            enforcement: 'shadow_only',
            range: expect.objectContaining({
              status: 'invalid',
              invalidReason: 'splits_surrogate_pair',
            }),
          }),
        ],
      }),
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ category: 'invalid', code: 'INVALID_UTF16_RANGE' }),
    ]);
  });

  it('promotes malformed markup only when an independent carrier proves the same target', () => {
    const target = 'https://independent.example/path';
    const result = extractNavigationEvidence(
      adaptMaxMessageNavigationView({
        body: {
          text: 'Label',
          markup: [{ type: 'link', url: target }],
          attachments: [{ type: 'share', payload: { url: target } }],
        },
      }),
    );

    expect(result.targets).toEqual([
      expect.objectContaining({
        target,
        enforceable: true,
        origins: [
          expect.objectContaining({ carrier: 'link_markup', enforcement: 'shadow_only' }),
          expect.objectContaining({ carrier: 'share_attachment', enforcement: 'eligible' }),
        ],
      }),
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ category: 'ambiguous', code: 'MISSING_UTF16_RANGE' }),
    ]);
  });

  it('enforces non-HTTP link markup while rejecting malformed mention and action targets', () => {
    const result = extractNavigationEvidence(
      adaptMaxMessageNavigationView({
        body: {
          text: 'Bad targets',
          markup: [
            { type: 'link', from: 0, length: 3, url: 'javascript:alert(1)' },
            { type: 'user_mention', from: 4, length: 7, user_link: 'https://evil.example' },
            { type: 'mystery', from: 0, length: 3, url: 'https://unknown.example/path' },
            { type: 'link', from: 0, length: 3 },
          ],
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [{ type: 'link', url: 'not a url' }],
                  [{ type: 'open_app', web_app: 'http://insecure-app.example/' }],
                  [{ type: 'mystery', url: 'https://unknown-button.example/path' }],
                ],
              },
            },
            { type: 'mystery', payload: { url: 'https://unknown-attachment.example/path' } },
          ],
        },
      }),
    );

    expect(result.targets).toEqual([
      expect.objectContaining({
        kind: 'external_url',
        target: 'javascript:alert(1)',
        enforceable: true,
        origins: [expect.objectContaining({ carrier: 'link_markup' })],
      }),
      expect.objectContaining({
        kind: 'external_url',
        target: 'https://unknown.example/path',
        enforceable: true,
        origins: [expect.objectContaining({ carrier: 'link_markup' })],
      }),
    ]);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      'INVALID_NAVIGATION_TARGET',
      'UNKNOWN_MARKUP_TYPE',
      'AMBIGUOUS_TARGET',
      'INVALID_NAVIGATION_TARGET',
      'INVALID_NAVIGATION_TARGET',
      'UNKNOWN_BUTTON_TYPE',
      'UNKNOWN_ATTACHMENT_TYPE',
    ]);
  });

  it('extracts an unexpected URL on user-mention markup as an independent link target', () => {
    const label = '@participant';
    const result = extractNavigationEvidence(
      adaptMaxMessageNavigationView({
        body: {
          text: label,
          markup: [
            {
              type: 'user_mention',
              from: 0,
              length: label.length,
              user_id: 67123224,
              url: 'https://outside.example/hidden',
            },
          ],
        },
      }),
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.targets).toEqual([
      expect.objectContaining({
        kind: 'external_url',
        target: 'https://outside.example/hidden',
        origins: [expect.objectContaining({ carrier: 'link_markup' })],
      }),
      expect.objectContaining({
        kind: 'profile_mention',
        target: 'max://user/67123224',
        origins: [expect.objectContaining({ carrier: 'user_mention_markup' })],
      }),
    ]);
  });

  it('extracts an unexpected custom-scheme URL as an independent link target', () => {
    const label = '@participant';
    const result = extractNavigationEvidence(
      adaptMaxMessageNavigationView({
        body: {
          text: label,
          markup: [
            {
              type: 'user_mention',
              from: 0,
              length: label.length,
              user_id: 67123224,
              url: 'tg://resolve?domain=outside',
            },
          ],
        },
      }),
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.targets).toEqual([
      expect.objectContaining({
        kind: 'external_url',
        target: 'tg://resolve?domain=outside',
        enforceable: true,
      }),
      expect.objectContaining({ kind: 'profile_mention' }),
    ]);
  });

  it('adapts message_edited explicitly and reports ambiguous envelope paths', () => {
    const edited = extractNavigationEvidence(
      adaptMaxWebhookNavigationView({
        update_type: 'message_edited',
        message_edited: {
          message: {
            body: {
              text: 'Edited',
              attachments: [{ type: 'share', payload: { url: 'https://edited.example/path' } }],
            },
          },
        },
      }),
    );

    expect(edited.targets).toEqual([
      expect.objectContaining({ target: 'https://edited.example/path', enforceable: true }),
    ]);
    expect(edited.targets[0].origins[0].sourcePath).toContain('message_edited.message.body');

    const ambiguous = extractNavigationEvidence(
      adaptMaxWebhookNavigationView({
        message: {
          body: {
            text: 'First',
            attachments: [{ type: 'share', payload: { url: 'https://first.example/path' } }],
          },
        },
        data: {
          message: {
            body: {
              text: 'Second',
              attachments: [{ type: 'share', payload: { url: 'https://second.example/path' } }],
            },
          },
        },
      }),
    );

    expect(ambiguous.targets.map((target) => target.target)).toEqual([
      'https://first.example/path',
    ]);
    expect(ambiguous.diagnostics).toEqual([
      expect.objectContaining({ category: 'ambiguous', code: 'AMBIGUOUS_MESSAGE_PATH' }),
    ]);
  });

  it('adapts parser-compatible nested data and direct content message envelopes', () => {
    const nestedData = extractNavigationEvidence(
      adaptMaxWebhookNavigationView({
        update_type: 'message_created',
        message_created: {
          data: {
            message: {
              content: {
                text: 'Nested',
                markup: [
                  {
                    type: 'link',
                    from: 0,
                    length: 6,
                    url: 'https://nested.example/path',
                  },
                ],
              },
            },
          },
        },
      }),
    );
    const directContent = extractNavigationEvidence(
      adaptMaxWebhookNavigationView({
        update_type: 'message_created',
        message_created: {
          message_id: 'message-1',
          content: {
            text: 'Direct',
            attachments: [
              { type: 'share', payload: { url: 'https://direct-content.example/path' } },
            ],
          },
        },
      }),
    );

    expect(nestedData.targets).toEqual([
      expect.objectContaining({ target: 'https://nested.example/path', enforceable: true }),
    ]);
    expect(nestedData.targets[0]?.origins[0]?.sourcePath).toContain(
      'message_created.data.message.content',
    );
    expect(directContent.targets).toEqual([
      expect.objectContaining({
        target: 'https://direct-content.example/path',
        enforceable: true,
      }),
    ]);
    expect(directContent.targets[0]?.origins[0]?.sourcePath).toContain('message_created.content');
  });

  it('uses the same recursively selected message node as the webhook parser', () => {
    const result = extractNavigationEvidence(
      adaptMaxWebhookNavigationView({
        update_type: 'message_created',
        data: {
          wrapper: {
            id: 'message-wrapped-1',
            recipient: { chat_id: 'chat-1' },
            sender: { id: 'user-1' },
            body: {
              text: 'Label',
              markup: [
                {
                  type: 'link',
                  from: 0,
                  length: 5,
                  url: 'https://hidden.example/path',
                },
              ],
            },
          },
        },
      }),
    );

    expect(result.targets).toEqual([
      expect.objectContaining({ target: 'https://hidden.example/path', enforceable: true }),
    ]);
    expect(result.targets[0]?.origins[0]?.sourcePath).toContain('data.wrapper.body.markup');
  });

  it('keeps the wrapped outer message as the navigation boundary for forwards', () => {
    const view = adaptMaxWebhookNavigationView({
      update_type: 'message_created',
      data: {
        wrapper: {
          id: 'outer-message',
          recipient: { chat_id: 'managed-chat' },
          sender: { id: 'outer-user' },
          body: {
            text: 'Outer',
            markup: [
              {
                type: 'link',
                from: 0,
                length: 5,
                url: 'https://outer.example/path',
              },
            ],
          },
          link: {
            type: 'forward',
            message: {
              id: 'inner-message',
              recipient: { chat_id: 'source-chat' },
              sender: { id: 'inner-user' },
              body: { text: 'Inner' },
              timestamp: 1772249118580,
            },
          },
        },
      },
    });

    expect(view.messagePath).toBe('data.wrapper');
    expect(extractNavigationEvidence(view).targets).toEqual([
      expect.objectContaining({ target: 'https://outer.example/path', enforceable: true }),
    ]);
  });

  it('ignores recursive chat metadata before the actual wrapped message', () => {
    const view = adaptMaxWebhookNavigationView({
      update_type: 'message_created',
      data: {
        meta: {
          id: 'metadata',
          chat_id: 'managed-chat',
          link: { url: 'https://chat-metadata.example/path' },
        },
        wrapper: {
          recipient: { chat_id: 'managed-chat' },
          sender: { user_id: 111 },
          timestamp: 1772249118580,
          body: {
            mid: 'actual-message',
            text: 'Label',
            markup: [
              {
                type: 'link',
                from: 0,
                length: 5,
                url: 'https://actual.example/path',
              },
            ],
          },
        },
      },
    });

    expect(view.messagePath).toBe('data.wrapper');
    expect(extractNavigationEvidence(view).targets).toEqual([
      expect.objectContaining({ target: 'https://actual.example/path', enforceable: true }),
    ]);
  });

  it('prefers a real wrapped message over a content-shaped data container', () => {
    const view = adaptMaxWebhookNavigationView({
      update_type: 'message_created',
      data: {
        id: 'metadata',
        chat_id: 'managed-chat',
        body: { text: 'Metadata body' },
        wrapper: {
          recipient: { chat_id: 'managed-chat' },
          sender: { user_id: 111 },
          timestamp: 1772249118580,
          body: {
            mid: 'actual-message',
            text: 'Label',
            markup: [
              {
                type: 'link',
                from: 0,
                length: 5,
                url: 'https://actual-wrapper.example/path',
              },
            ],
          },
        },
      },
    });

    expect(view.messagePath).toBe('data.wrapper');
    expect(extractNavigationEvidence(view).targets).toEqual([
      expect.objectContaining({
        target: 'https://actual-wrapper.example/path',
        enforceable: true,
      }),
    ]);
  });

  it('changes content fingerprints when navigation-relevant content changes', () => {
    const first = adaptMaxMessageNavigationView({
      body: {
        text: 'Link',
        attachments: [{ type: 'share', payload: { url: 'https://first.example/path' } }],
      },
    });
    const repeated = adaptMaxMessageNavigationView({
      body: {
        text: 'Link',
        attachments: [{ type: 'share', payload: { url: 'https://first.example/path' } }],
      },
    });
    const edited = adaptMaxMessageNavigationView({
      body: {
        text: 'Link',
        attachments: [{ type: 'share', payload: { url: 'https://second.example/path' } }],
      },
    });

    expect(first.direct?.contentFingerprint).toBe(repeated.direct?.contentFingerprint);
    expect(first.direct?.contentFingerprint).not.toBe(edited.direct?.contentFingerprint);
  });
});
