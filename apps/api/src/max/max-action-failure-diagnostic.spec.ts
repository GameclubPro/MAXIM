import {
  projectMaxActionFailureDiagnostic,
  type MaxActionFailureFacts,
} from './max-action-failure-diagnostic';

describe('2A0 MAX action failure diagnostic', () => {
  it.each<MaxActionFailureFacts>([
    { failureOrigin: 'local_quota', isCritical: true },
    { failureOrigin: 'unlinked', isCritical: true },
    { failureOrigin: 'unlinked', isCritical: false },
  ])('projects only the finite diagnostic fields for %j', (facts) => {
    const input = Object.freeze({
      ...facts,
      botId: 'private-bot',
      chatId: 'private-chat',
      token: 'private-token',
      url: 'https://private.example/messages',
      requestAssociation: 'matched',
      method: 'post',
      endpointKind: 'messages',
    });

    expect(projectMaxActionFailureDiagnostic(input)).toStrictEqual({
      failureOrigin: facts.failureOrigin,
      isCritical: facts.isCritical,
      requestAssociation: 'unlinked',
      method: 'unknown',
      endpointKind: 'unknown',
    });
    expect(input.requestAssociation).toBe('matched');
    expect(input.method).toBe('post');
  });
});
