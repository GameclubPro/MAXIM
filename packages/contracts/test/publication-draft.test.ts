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
