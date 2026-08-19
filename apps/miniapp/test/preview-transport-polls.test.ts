import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManagedEntityType } from '@maxim/contracts';
import { decodeManagedPollListCursor } from '@maxim/contracts/poll';
import {
  closeManagedPoll,
  createManagedPoll,
  deleteManagedPoll,
  getManagedPoll,
  getManagedPollVoters,
  getManagedPolls,
  publishManagedPoll,
  refreshManagedPollPublication,
  resetManagedPollPublication,
  updateManagedPoll,
} from '../src/lib/api/managed-polls-client';
import { ApiRequestError } from '../src/lib/api-request-error';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';

for (const entityType of ['chat', 'channel'] as const satisfies readonly ManagedEntityType[]) {
  test(`preview ${entityType} polls support history, voters, and draft lifecycle`, async () => {
    let now = new Date('2026-08-11T09:00:00.000Z');
    const api = createPreviewApiTransport({ clock: { now: () => now } });
    const entityId = `preview-${entityType}`;
    const activePollId = `poll-${entityType}-active`;
    const closedPollId = `poll-${entityType}-closed`;
    const initial = await getManagedPolls(api, entityType, entityId);
    const firstPage = await getManagedPolls(api, entityType, entityId, { limit: 1 });
    const initialCurrent = await getManagedPolls(api, entityType, entityId, {
      scope: 'current',
    });
    const initialArchive = await getManagedPolls(api, entityType, entityId, {
      scope: 'archive',
    });

    assert.equal(firstPage.items.length, 1);
    assert.equal(typeof firstPage.nextCursor, 'string');
    const firstPoll = firstPage.items[0];
    const firstCursor = firstPage.nextCursor;
    assert.ok(firstPoll);
    assert.ok(firstCursor);
    assert.deepEqual(decodeManagedPollListCursor(firstCursor), {
      v: 1,
      createdAt: firstPoll.createdAt,
      id: firstPoll.id,
      chatId: entityId,
      scope: 'all',
    });
    const secondPage = await getManagedPolls(api, entityType, entityId, {
      cursor: firstCursor,
      limit: 1,
    });
    assert.equal(secondPage.items.length, 1);
    assert.notEqual(secondPage.items[0]?.id, firstPoll.id);
    const legacySecondPage = await getManagedPolls(api, entityType, entityId, {
      cursor: firstPoll.id,
      limit: 1,
    });
    assert.deepEqual(
      legacySecondPage.items.map((poll) => poll.id),
      secondPage.items.map((poll) => poll.id),
    );
    await assert.rejects(
      getManagedPolls(api, entityType, entityId, {
        scope: 'current',
        cursor: firstCursor,
        limit: 1,
      }),
      /cursor is invalid/u,
    );
    await assert.rejects(
      getManagedPolls(api, entityType, `${entityId}-other`, {
        cursor: firstCursor,
        limit: 1,
      }),
      /cursor is invalid/u,
    );
    assert.equal(firstPage.total, initial.total);
    assert.equal(initial.total, initial.items.length);
    assert.equal(initialCurrent.total, initialCurrent.items.length);
    assert.equal(initialArchive.total, initialArchive.items.length);
    assert.equal(
      initialCurrent.items.every((poll) => poll.status !== 'CLOSED'),
      true,
    );
    assert.equal(
      initialArchive.items.every((poll) => poll.status === 'CLOSED'),
      true,
    );
    assert.equal(
      initial.items.some((poll) => poll.status === 'ACTIVE'),
      true,
    );
    assert.equal(
      initial.items.some((poll) => poll.status === 'CLOSED'),
      true,
    );
    const voters = await getManagedPollVoters(api, entityType, entityId, activePollId, {
      limit: 2,
    });
    assert.equal(voters.items.length, 2);
    assert.equal(typeof voters.nextCursor, 'string');

    const repaired = await refreshManagedPollPublication(api, entityType, entityId, closedPollId);
    assert.equal(repaired.renderRepairNeeded, false);
    await assert.rejects(
      resetManagedPollPublication(api, entityType, entityId, activePollId),
      /Публикация не требует сброса/u,
    );

    const authoredQuestion = '**Какой день** удобнее?';
    const authoredOptions = ['Пятница', 'Суббота'];
    const created = await createManagedPoll(api, entityType, entityId, {
      question: authoredQuestion,
      questionFormat: 'markdown',
      visibility: 'ANONYMOUS',
      images: [
        {
          base64: 'cHJldmlldy1wb2xsLWltYWdl',
          mimeType: 'image/jpeg',
          fileName: 'poll.jpg',
        },
      ],
      options: [
        { id: 'client-option-1', text: authoredOptions[0] },
        { id: 'client-option-2', text: authoredOptions[1] },
      ],
    });
    assert.equal(created.status, 'DRAFT');
    assert.equal(created.question, authoredQuestion);
    assert.deepEqual(
      created.options.map((option) => option.text),
      authoredOptions,
    );
    assert.equal(
      created.options.some((option) => option.id.startsWith('client-option-')),
      false,
    );
    assert.equal(created.questionFormat, 'markdown');
    assert.equal(created.images.length, 1);

    const createdSummary = (await getManagedPolls(api, entityType, entityId)).items.find(
      (poll) => poll.id === created.id,
    );
    assert.equal(createdSummary?.imageCount, 1);
    assert.equal('images' in (createdSummary ?? {}), false);

    const createdDetails = await getManagedPoll(api, entityType, entityId, created.id);
    assert.deepEqual(createdDetails.images, created.images);

    now = new Date('2026-08-11T09:01:00.000Z');
    const firstUpdated = await updateManagedPoll(api, entityType, entityId, created.id, {
      question: 'Когда встречаемся?',
      expectedUpdatedAt: createdDetails.updatedAt,
      options: created.options.map((option) => ({ id: option.id, text: option.text })),
    });
    assert.equal(firstUpdated.visibility, created.visibility);
    assert.equal(firstUpdated.questionFormat, 'markdown');
    assert.deepEqual(firstUpdated.images, created.images);

    now = new Date('2026-08-11T09:02:00.000Z');
    await assert.rejects(
      updateManagedPoll(api, entityType, entityId, created.id, {
        question: 'Локальный устаревший вопрос',
        expectedUpdatedAt: createdDetails.updatedAt,
        options: created.options.map((option, index) => ({
          id: option.id,
          text: index === 0 ? 'Устаревший ответ' : option.text,
        })),
      }),
      (error: unknown) => {
        assert.equal(error instanceof ApiRequestError, true);
        const conflict = error as ApiRequestError;
        assert.equal(conflict.status, 409);
        assert.equal(conflict.message, 'Черновик опроса уже изменён. Обновите экран.');
        return true;
      },
    );
    const afterConflict = await getManagedPoll(api, entityType, entityId, created.id);
    assert.equal(afterConflict.question, firstUpdated.question);
    assert.deepEqual(afterConflict.options, firstUpdated.options);
    assert.equal(afterConflict.updatedAt, firstUpdated.updatedAt);

    const updated = await updateManagedPoll(api, entityType, entityId, created.id, {
      question: 'Когда встречаемся?',
      expectedUpdatedAt: firstUpdated.updatedAt,
      questionFormat: 'plain',
      visibility: 'OPEN',
      images: [],
      options: created.options.map((option) => ({ id: option.id, text: option.text })),
    });
    assert.equal(updated.visibility, 'OPEN');
    assert.equal(updated.questionFormat, 'plain');
    assert.equal(updated.imageCount, 0);

    const published = await publishManagedPoll(api, entityType, entityId, created.id);
    assert.equal(published.status, 'ACTIVE');
    const concurrentlyCreated = await createManagedPoll(api, entityType, entityId, {
      question: 'Какой формат выбрать следующим?',
      visibility: 'ANONYMOUS',
      options: [{ text: 'Текст' }, { text: 'Видео' }],
    });
    const concurrentlyPublished = await publishManagedPoll(
      api,
      entityType,
      entityId,
      concurrentlyCreated.id,
    );
    assert.notEqual(concurrentlyPublished.id, published.id);
    assert.notEqual(concurrentlyPublished.publicationMessageId, published.publicationMessageId);

    const activeTogether = await getManagedPolls(api, entityType, entityId, {
      scope: 'current',
    });
    assert.equal(activeTogether.items.find((poll) => poll.id === activePollId)?.status, 'ACTIVE');
    assert.equal(activeTogether.items.find((poll) => poll.id === published.id)?.status, 'ACTIVE');
    assert.equal(
      activeTogether.items.find((poll) => poll.id === concurrentlyPublished.id)?.status,
      'ACTIVE',
    );

    const closed = await closeManagedPoll(api, entityType, entityId, created.id);
    assert.equal(closed.status, 'CLOSED');
    const afterClose = await getManagedPolls(api, entityType, entityId, { scope: 'current' });
    const archiveAfterClose = await getManagedPolls(api, entityType, entityId, {
      scope: 'archive',
    });
    assert.equal(afterClose.items.find((poll) => poll.id === activePollId)?.status, 'ACTIVE');
    assert.equal(
      afterClose.items.some((poll) => poll.id === closed.id),
      false,
    );
    assert.equal(archiveAfterClose.items.find((poll) => poll.id === closed.id)?.status, 'CLOSED');
    assert.equal(
      afterClose.items.find((poll) => poll.id === concurrentlyPublished.id)?.status,
      'ACTIVE',
    );

    const disposable = await createManagedPoll(api, entityType, entityId, {
      question: 'Удалить этот черновик?',
      visibility: 'ANONYMOUS',
      options: [{ text: 'Да' }, { text: 'Нет' }],
    });
    const beforeDelete = await getManagedPolls(api, entityType, entityId, { scope: 'current' });
    await deleteManagedPoll(api, entityType, entityId, disposable.id);
    const final = await getManagedPolls(api, entityType, entityId, { scope: 'current' });
    assert.equal(final.total, beforeDelete.total - 1);
    assert.equal(
      final.items.some((poll) => poll.id === disposable.id),
      false,
    );
  });
}
