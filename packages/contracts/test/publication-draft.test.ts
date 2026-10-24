import { describe, expect, it } from 'vitest';
import { savePublicationDraftRequestSchema } from '../src/publication-draft';
import { publicationContentInputSchema } from '../src/publication';

const request = {
  requestId: 'draft-request',
  title: '',
  content: { text: '', media: [], buttons: [] },
  targets: [],
  state: {
    formatVersion: 1,
    timingMode: 'once',
    scheduleKind: 'slots',
    scheduleTimezone: 'Europe/Moscow',
    scheduledSlots: [],
    onceDate: '',
    onceTime: '',
    buttons: [{ text: '', url: '' }],
    buttonEnabled: true,
    recurrence: {
      frequency: 'weekly',
      interval: 1,
      weekdays: [],
      times: [''],
      startsAt: null,
      endsAt: null,
      maxOccurrences: null,
    },
  },
};
describe('server draft contract', () => {
  it('retains previously persisted minute UTC slots and recurrence values without normalizing', () => {
    const state = {
      ...request.state,
      scheduledSlots: ['2026-10-20T00:00Z', '2026-10-21T00:00:00.123456789Z'],
      recurrence: {
        ...request.state.recurrence,
        startsAt: '2026-10-20T00:00Z',
        endsAt: '2026-10-21T00:00Z',
      },
    };
    const parsed = savePublicationDraftRequestSchema.parse({ ...request, state });
    expect(parsed.state).toEqual(state);
    expect(JSON.parse(JSON.stringify(parsed.state))).toEqual(state);
    for (const value of ['2026-10-20T00:00+03:00', '2026-02-30T00:00Z']) {
      expect(
        savePublicationDraftRequestSchema.safeParse({
          ...request,
          state: { ...state, scheduledSlots: [value] },
        }).success,
      ).toBe(false);
    }
  });
  it('allows incomplete drafts but keeps publishing content strict', () => {
    expect(savePublicationDraftRequestSchema.safeParse(request).success).toBe(true);
    expect(publicationContentInputSchema.safeParse(request.content).success).toBe(false);
  });
  it('rejects invalid versions, zones and unbounded editor state', () => {
    expect(
      savePublicationDraftRequestSchema.safeParse({ ...request, expectedRevision: 0 }).success,
    ).toBe(false);
    expect(
      savePublicationDraftRequestSchema.safeParse({
        ...request,
        state: { ...request.state, scheduleTimezone: 'unknown' },
      }).success,
    ).toBe(false);
    expect(
      savePublicationDraftRequestSchema.safeParse({
        ...request,
        state: {
          ...request.state,
          buttons: Array.from({ length: 9 }, () => ({ text: '', url: '' })),
        },
      }).success,
    ).toBe(false);
  });
  it('rejects duplicate recipients and unknown top-level fields', () => {
    const target = { chatId: '-100', entityType: 'chat' };
    expect(
      savePublicationDraftRequestSchema.safeParse({ ...request, targets: [target, target] })
        .success,
    ).toBe(false);
    expect(
      savePublicationDraftRequestSchema.safeParse({ ...request, actorUserId: 'other' }).success,
    ).toBe(false);
  });
});
