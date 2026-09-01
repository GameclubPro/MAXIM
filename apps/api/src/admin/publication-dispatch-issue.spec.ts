import {
  buildPublicationDispatchIssueIndex,
  PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE,
  resolvePublicationDispatchIssue,
} from './publication-dispatch-issue';

describe('publication dispatch issue', () => {
  it('maps the observed Publisher actor blocker without exposing its internal code', () => {
    expect(PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE).toBe('PUBLISHER_ACTOR_ACCESS_REQUIRED');
    expect(resolvePublicationDispatchIssue([PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE])).toBe(
      'actor_access_required',
    );
  });

  it('prioritizes actor access over target setup and temporary blockers', () => {
    expect(
      resolvePublicationDispatchIssue([
        'publisher_runtime_unavailable',
        'policy_disabled',
        'PUBLISHER_ACTOR_ACCESS_REQUIRED',
      ]),
    ).toBe('actor_access_required');
    expect(
      resolvePublicationDispatchIssue(['publisher_runtime_unavailable', 'bot_not_admin']),
    ).toBe('target_setup_required');
    expect(resolvePublicationDispatchIssue(['unexpected_internal_blocker'])).toBe(
      'temporarily_unavailable',
    );
  });

  it('builds publication and occurrence indexes from sanitized values only', () => {
    const index = buildPublicationDispatchIssueIndex([
      {
        publicationId: 'publication-1',
        occurrenceId: 'occurrence-1',
        blockerCode: 'publisher_runtime_unavailable',
      },
      {
        publicationId: 'publication-1',
        occurrenceId: 'occurrence-2',
        blockerCode: 'PUBLISHER_ACTOR_ACCESS_REQUIRED',
      },
    ]);

    expect(index.byPublicationId.get('publication-1')).toBe('actor_access_required');
    expect(index.byOccurrenceId.get('occurrence-1')).toBe('temporarily_unavailable');
    expect(index.byOccurrenceId.get('occurrence-2')).toBe('actor_access_required');
    expect(JSON.stringify([...index.byPublicationId, ...index.byOccurrenceId])).not.toContain(
      'PUBLISHER_ACTOR_ACCESS_REQUIRED',
    );
  });
});
