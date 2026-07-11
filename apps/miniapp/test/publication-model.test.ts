import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCreatePublicationRequest,
  buildPublicationContent,
  buildTestPublicationRequest,
  canResumePublication,
  createEmptyPublicationDraft,
  createPublicationDuplicateDraft,
  filterFuturePublicationSlots,
  inferPublicationVideoMimeType,
  isIsolatedPublicationEditor,
  isPublicationScheduleConflictError,
  isPublicationScheduleConflictMessage,
  shouldReviewPublicationScheduleConflict,
  shouldPersistPublicationDraft,
} from '../src/features/publications/publication-model';
import {
  buildPublicationDraftStorageKey,
  parsePublicationDraftEnvelope,
} from '../src/features/publications/publication-draft-storage';
import {
  createPublication,
  getPublicationCalendarAvailability,
  testPublication,
} from '../src/lib/api/publication-client';
import type { ApiRequestInit, ApiTransport } from '../src/lib/api/transport';

const chatTarget = {
  id: 'chat-1',
  entityType: 'chat' as const,
  title: 'Чат',
  avatarUrl: null,
};
const channelTarget = {
  id: 'channel-1',
  entityType: 'channel' as const,
  title: 'Канал',
  avatarUrl: null,
};

test('isolates edit and duplicate drafts from the persisted create draft', () => {
  assert.equal(shouldPersistPublicationDraft(null), true);
  assert.equal(shouldPersistPublicationDraft('create'), true);
  assert.equal(shouldPersistPublicationDraft('edit'), false);
  assert.equal(shouldPersistPublicationDraft('duplicate'), false);
  assert.equal(isIsolatedPublicationEditor('edit'), true);
  assert.equal(isIsolatedPublicationEditor('duplicate'), true);
});

test('starts a new publication without a recipient or a publishable schedule', () => {
  const draft = createEmptyPublicationDraft();

  assert.deepEqual(draft.targets, []);
  assert.deepEqual(draft.scheduledSlots, []);
  assert.equal(draft.onceDate, '');
  assert.equal(draft.onceTime, '');
  assert.deepEqual(draft.recurrence, {
    frequency: 'weekly',
    interval: 1,
    weekdays: [],
    times: [],
    startsAt: null,
    endsAt: null,
    maxOccurrences: null,
  });
});

test('duplicates content and recipients but requires a new schedule choice', () => {
  const source = createEmptyPublicationDraft([chatTarget, channelTarget]);
  source.title = 'Утренний дайджест';
  source.text = 'Доброе утро';
  source.timingMode = 'schedule';
  source.scheduleKind = 'recurrence';
  source.scheduledSlots = ['2026-08-01T07:00:00.000Z'];
  source.onceDate = '2026-08-01';
  source.onceTime = '10:00';
  source.recurrence = {
    frequency: 'weekly',
    interval: 1,
    weekdays: [1, 3],
    times: ['10:00'],
    startsAt: '2026-08-01T00:00:00.000Z',
    endsAt: null,
    maxOccurrences: 30,
  };

  const duplicate = createPublicationDuplicateDraft(source);

  assert.equal(duplicate.title, source.title);
  assert.equal(duplicate.text, source.text);
  assert.deepEqual(duplicate.targets, source.targets);
  assert.equal(duplicate.timingMode, 'schedule');
  assert.equal(duplicate.scheduleKind, 'slots');
  assert.deepEqual(duplicate.scheduledSlots, []);
  assert.equal(duplicate.onceDate, '');
  assert.equal(duplicate.onceTime, '');
  assert.deepEqual(duplicate.recurrence.weekdays, []);
  assert.deepEqual(duplicate.recurrence.times, []);
  assert.equal(duplicate.recurrence.startsAt, null);
});

test('scopes publication drafts by MAX user id', () => {
  assert.equal(buildPublicationDraftStorageKey('1001'), 'maxim:publications-composer:v1:1001');
  assert.equal(buildPublicationDraftStorageKey('1002'), 'maxim:publications-composer:v1:1002');
  assert.notEqual(buildPublicationDraftStorageKey('1001'), buildPublicationDraftStorageKey('1002'));
  assert.equal(buildPublicationDraftStorageKey(null), 'maxim:publications-composer:v1:anonymous');
});

test('keeps intentional schedules when migrating a legacy publication draft', () => {
  const slotsDraft = parsePublicationDraftEnvelope({
    version: 1,
    savedAt: '2026-07-11T09:00:00.000Z',
    draft: {
      timingMode: 'schedule',
      scheduleKind: 'slots',
      scheduledSlots: ['2026-08-01T09:00:00.000Z'],
      recurrence: { weekdays: [1], times: ['09:00'] },
    },
  });
  const recurrenceDraft = parsePublicationDraftEnvelope({
    version: 1,
    savedAt: '2026-07-11T09:00:00.000Z',
    draft: {
      timingMode: 'schedule',
      scheduleKind: 'recurrence',
      scheduledSlots: ['2026-08-01T09:00:00.000Z'],
      recurrence: {
        frequency: 'weekly',
        interval: 2,
        weekdays: [1, 4],
        times: ['09:00'],
        startsAt: null,
        maxOccurrences: 12,
      },
    },
  });
  const nowDraft = parsePublicationDraftEnvelope({
    version: 1,
    savedAt: '2026-07-11T09:00:00.000Z',
    draft: {
      timingMode: 'now',
      scheduledSlots: ['2026-08-01T09:00:00.000Z'],
      recurrence: { weekdays: [1], times: ['09:00'] },
    },
  });

  assert.deepEqual(slotsDraft?.scheduledSlots, ['2026-08-01T09:00:00.000Z']);
  assert.deepEqual(recurrenceDraft?.scheduledSlots, []);
  assert.deepEqual(recurrenceDraft?.recurrence.weekdays, [1, 4]);
  assert.deepEqual(recurrenceDraft?.recurrence.times, ['09:00']);
  assert.equal(recurrenceDraft?.recurrence.startsAt, null);
  assert.equal(recurrenceDraft?.recurrence.maxOccurrences, 12);
  assert.deepEqual(nowDraft?.scheduledSlots, []);
  assert.deepEqual(nowDraft?.recurrence.weekdays, []);
  assert.deepEqual(nowDraft?.recurrence.times, []);
});

test('recognizes current publication calendar conflict copy', () => {
  assert.equal(
    isPublicationScheduleConflictMessage('В выбранное время уже запланирована публикация.'),
    true,
  );
  assert.equal(isPublicationScheduleConflictMessage('Сервис временно недоступен.'), false);
  assert.equal(
    isPublicationScheduleConflictMessage(
      'Конфликтующая публикация включает другие чаты или каналы. Измените её отдельно.',
    ),
    false,
  );
  assert.equal(
    isPublicationScheduleConflictError(
      Object.assign(new Error('Любой текст'), { code: 'PUBLICATION_SCHEDULE_CONFLICT' }),
    ),
    true,
  );
  assert.equal(
    isPublicationScheduleConflictError(
      Object.assign(new Error('Конфликт'), {
        code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW',
      }),
    ),
    false,
  );
});

test('reviews replaceable conflicts once for every scheduled mode', () => {
  const conflict = Object.assign(new Error('Это время уже занято другой публикацией.'), {
    code: 'PUBLICATION_SCHEDULE_CONFLICT',
  });
  const draft = createEmptyPublicationDraft([chatTarget]);

  draft.timingMode = 'once';
  assert.equal(shouldReviewPublicationScheduleConflict(conflict, draft, false), true);

  draft.timingMode = 'schedule';
  draft.scheduleKind = 'slots';
  assert.equal(shouldReviewPublicationScheduleConflict(conflict, draft, false), true);

  draft.scheduleKind = 'recurrence';
  assert.equal(shouldReviewPublicationScheduleConflict(conflict, draft, false), true);
  assert.equal(shouldReviewPublicationScheduleConflict(conflict, draft, true), false);

  draft.timingMode = 'now';
  assert.equal(shouldReviewPublicationScheduleConflict(conflict, draft, false), false);
});

test('only paused publications expose resume', () => {
  assert.equal(canResumePublication('PAUSED'), true);
  assert.equal(canResumePublication('ERROR'), false);
  assert.equal(canResumePublication('ACTIVE'), false);
});

test('infers safe video MIME types when Android omits file.type', () => {
  assert.equal(inferPublicationVideoMimeType('clip.mp4', ''), 'video/mp4');
  assert.equal(inferPublicationVideoMimeType('clip.MOV', ''), 'video/quicktime');
  assert.equal(inferPublicationVideoMimeType('clip.webm', ''), 'video/webm');
  assert.equal(inferPublicationVideoMimeType('clip.mkv', ''), 'video/x-matroska');
  assert.equal(inferPublicationVideoMimeType('clip.bin', ''), null);
  assert.equal(inferPublicationVideoMimeType('clip.mp4', 'application/octet-stream'), null);
});

test('drops past slots before opening a publication for editing', () => {
  const nowMs = Date.parse('2026-08-01T08:00:00.000Z');
  assert.deepEqual(
    filterFuturePublicationSlots(
      [
        '2026-08-01T07:00:00.000Z',
        '2026-08-01T08:01:00.000Z',
        '2026-08-01T08:30:00.000Z',
        '2026-08-02T08:30:00.000Z',
      ],
      nowMs,
    ),
    ['2026-08-01T08:30:00.000Z', '2026-08-02T08:30:00.000Z'],
  );
});

test('builds a publication with mixed chat and channel targets and finite slots', () => {
  const draft = createEmptyPublicationDraft([chatTarget, channelTarget]);
  draft.text = 'Плановый пост';
  draft.timingMode = 'schedule';
  draft.scheduleKind = 'slots';
  draft.scheduledSlots = ['2026-08-01T07:00:00.000Z', '2026-08-02T07:00:00.000Z'];

  const request = buildCreatePublicationRequest(draft, 'request_slots_001');

  assert.deepEqual(request.audience.targets, [
    { chatId: 'chat-1', entityType: 'chat' },
    { chatId: 'channel-1', entityType: 'channel' },
  ]);
  assert.deepEqual(request.schedule, {
    mode: 'slots',
    timezone: draft.scheduleTimezone,
    slots: draft.scheduledSlots,
    replaceConflicts: false,
  });
});

test('builds daily and weekly recurrence requests with conflict replacement', () => {
  const draft = createEmptyPublicationDraft([channelTarget]);
  draft.text = 'Регулярный пост';
  draft.timingMode = 'schedule';
  draft.scheduleKind = 'recurrence';
  draft.recurrence = {
    frequency: 'weekly',
    interval: 2,
    weekdays: [1, 5],
    times: ['09:00', '18:30'],
    startsAt: '2026-08-01T00:00:00.000Z',
    endsAt: null,
    maxOccurrences: 20,
  };

  const request = buildCreatePublicationRequest(draft, 'request_cycle_001', {
    replaceConflicts: true,
  });

  assert.deepEqual(request.schedule, {
    mode: 'recurrence',
    timezone: draft.scheduleTimezone,
    frequency: 'weekly',
    interval: 2,
    weekdays: [1, 5],
    times: ['09:00', '18:30'],
    startsAt: '2026-08-01T00:00:00.000Z',
    endsAt: null,
    maxOccurrences: 20,
    replaceConflicts: true,
  });
});

test('keeps retained asset references and builds a real video payload', () => {
  const retainedDraft = createEmptyPublicationDraft([chatTarget]);
  retainedDraft.text = 'Фото остаётся';
  retainedDraft.retainedAssets = [
    {
      id: 'asset-image-1',
      type: 'image',
      mimeType: 'image/jpeg',
      fileName: 'photo.jpg',
      sizeBytes: 120,
    },
  ];
  assert.deepEqual(buildPublicationContent(retainedDraft).media, [
    { type: 'image-ref', assetId: 'asset-image-1' },
  ]);

  const videoDraft = createEmptyPublicationDraft([channelTarget]);
  videoDraft.mediaType = 'video';
  videoDraft.mediaBase64 = 'dmlkZW8=';
  videoDraft.mediaMimeType = 'video/mp4';
  videoDraft.mediaFileName = 'clip.mp4';
  assert.deepEqual(buildPublicationContent(videoDraft).media, [
    {
      type: 'video',
      payload: null,
      base64: 'dmlkZW8=',
      mimeType: 'video/mp4',
      fileName: 'clip.mp4',
    },
  ]);
});

test('test publication request contains content and source target without a schedule', () => {
  const draft = createEmptyPublicationDraft([chatTarget]);
  draft.text = 'Тест';
  draft.timingMode = 'schedule';

  const request = buildTestPublicationRequest(draft, 'request_test_001');

  assert.equal('schedule' in request, false);
  assert.deepEqual(request.sourceTarget, { chatId: 'chat-1', entityType: 'chat' });
});

test('publication client uses v2 create and test endpoints', async () => {
  const calls: Array<{ path: string; init?: ApiRequestInit }> = [];
  const api: ApiTransport = {
    request: async (path, init) => {
      calls.push({ path, init });
      throw new Error('stop');
    },
    requestKeepalive: () => undefined,
  };
  const draft = createEmptyPublicationDraft([chatTarget, channelTarget]);
  draft.text = 'Проверка маршрута';

  await assert.rejects(
    createPublication(api, buildCreatePublicationRequest(draft, 'request_create_001')),
    /stop/u,
  );
  await assert.rejects(
    testPublication(api, buildTestPublicationRequest(draft, 'request_test_002')),
    /stop/u,
  );

  assert.deepEqual(
    calls.map((call) => [call.path, call.init?.method]),
    [
      ['/publications', 'POST'],
      ['/publications/test', 'POST'],
    ],
  );
});

test('publication client requests target-aware calendar availability', async () => {
  const calls: Array<{ path: string; init?: ApiRequestInit }> = [];
  const api: ApiTransport = {
    request: async (path, init) => {
      calls.push({ path, init });
      return {
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-31T23:59:59.999Z',
        slots: [{ scheduledAt: '2026-08-01T09:00:00.000Z', targetCount: 1 }],
      };
    },
    requestKeepalive: () => undefined,
  };

  const result = await getPublicationCalendarAvailability(api, {
    audience: {
      selection: 'SELECTED',
      mode: 'SNAPSHOT',
      targets: [{ chatId: chatTarget.id, entityType: chatTarget.entityType }],
    },
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
  });

  assert.deepEqual(result.slots, [{ scheduledAt: '2026-08-01T09:00:00.000Z', targetCount: 1 }]);
  assert.deepEqual(
    calls.map((call) => [call.path, call.init?.method]),
    [['/publications/calendar-availability', 'POST']],
  );
});
