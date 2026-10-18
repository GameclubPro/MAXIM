import {
  projectMaxActionFailureDiagnostic,
  type MaxActionFailureFacts,
} from './max-action-failure-diagnostic';
import {
  beginMaxHttpFailureRequest,
  consumeMaxHttpOutcome,
  createMaxHttpFailureOwner,
  maxHttpFailureOutcome,
  type MaxHttpFailureAssociation,
} from './max-http-failure-association';

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

describe('Exact MAX HTTP failure diagnostic projection', () => {
  function association(): MaxHttpFailureAssociation {
    const owner = createMaxHttpFailureOwner();
    const outcome = consumeMaxHttpOutcome(
      owner,
      maxHttpFailureOutcome(
        beginMaxHttpFailureRequest(owner, 'delete', 'messages'),
        new Error('private error'),
        'response_rejection',
        404,
      ),
    );
    if (outcome.kind !== 'failure' || !outcome.association) throw new Error('Expected association');
    return outcome.association;
  }

  it.each([true, false])('whitelists linked facts without changing critical=%j', (isCritical) => {
    const proof = Object.assign(association(), {
      token: 'private-token',
      botId: 'private-bot',
      chatId: 'private-chat',
      url: 'https://private.example/messages',
      body: { private: true },
    });
    const projected = projectMaxActionFailureDiagnostic(
      { failureOrigin: 'unlinked', isCritical },
      proof,
    );
    expect(projected).toStrictEqual({
      failureOrigin: 'unlinked',
      isCritical,
      requestAssociation: 'linked',
      method: 'delete',
      endpointKind: 'messages',
      phase: 'response_rejection',
      receivedStatusCode: 404,
    });
    expect(JSON.stringify(projected)).not.toContain('private');
    expect(Object.getOwnPropertySymbols(projected)).toEqual([]);
  });

  it('preserves the exact existing local-quota shape even with genuine HTTP evidence', () => {
    expect(
      projectMaxActionFailureDiagnostic(
        { failureOrigin: 'local_quota', isCritical: true },
        association(),
      ),
    ).toStrictEqual({
      failureOrigin: 'local_quota',
      isCritical: true,
      requestAssociation: 'unlinked',
      method: 'unknown',
      endpointKind: 'unknown',
    });
  });

  it('fails open for missing, forged, invalid or inaccessible evidence', () => {
    const invalid = Object.assign(association(), {
      phase: 'private-unsupported',
      receivedStatusCode: Number.NaN,
    });
    const inaccessible = new Proxy(association(), {
      get: () => {
        throw new Error('diagnostic unavailable');
      },
    });
    for (const proof of [undefined, null, {}, invalid, inaccessible]) {
      expect(
        projectMaxActionFailureDiagnostic(
          { failureOrigin: 'unlinked', isCritical: false },
          proof as MaxHttpFailureAssociation | null | undefined,
        ),
      ).toStrictEqual({
        failureOrigin: 'unlinked',
        isCritical: false,
        requestAssociation: 'unlinked',
        method: 'unknown',
        endpointKind: 'unknown',
      });
    }
  });
});
