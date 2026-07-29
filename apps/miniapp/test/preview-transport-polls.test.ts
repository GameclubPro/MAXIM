import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManagedEntityType } from '@maxim/contracts';
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
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';

for (const entityType of ['chat', 'channel'] as const satisfies readonly ManagedEntityType[]) {
  test(`preview ${entityType} polls support history, voters, and draft lifecycle`, async () => {
    const api = createPreviewApiTransport();
    const entityId = `preview-${entityType}`;
    const activePollId = `poll-${entityType}-active`;
    const closedPollId = `poll-${entityType}-closed`;
    const initial = await getManagedPolls(api, entityType, entityId);
    const firstPage = await getManagedPolls(api, entityType, entityId, { limit: 1 });

    assert.equal(firstPage.items.length, 1);
    assert.equal(typeof firstPage.nextCursor, 'string');
    assert.equal(
      initial.items.some((poll) => poll.status === 'ACTIVE'),
      true,
    );
    assert.equal(
      initial.items.some((poll) => poll.status === 'CLOSED'),
      true,
    );
    await assert.rejects(
      createManagedPoll(api, entityType, entityId, {
        question: 'Второй текущий опрос?',
        visibility: 'ANONYMOUS',
        options: [{ text: 'Да' }, { text: 'Нет' }],
      }),
      /Сначала завершите текущий опрос/u,
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

    await closeManagedPoll(api, entityType, entityId, activePollId);

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

    const legacyUpdated = await updateManagedPoll(api, entityType, entityId, created.id, {
      question: 'Когда встречаемся?',
      visibility: 'ANONYMOUS',
      options: created.options.map((option) => ({ id: option.id, text: option.text })),
    });
    assert.equal(legacyUpdated.questionFormat, 'markdown');
    assert.deepEqual(legacyUpdated.images, created.images);

    const updated = await updateManagedPoll(api, entityType, entityId, created.id, {
      question: 'Когда встречаемся?',
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
    const closed = await closeManagedPoll(api, entityType, entityId, created.id);
    assert.equal(closed.status, 'CLOSED');

    const disposable = await createManagedPoll(api, entityType, entityId, {
      question: 'Удалить этот черновик?',
      visibility: 'ANONYMOUS',
      options: [{ text: 'Да' }, { text: 'Нет' }],
    });
    await deleteManagedPoll(api, entityType, entityId, disposable.id);
    const final = await getManagedPolls(api, entityType, entityId);
    assert.equal(
      final.items.some((poll) => poll.id === disposable.id),
      false,
    );
  });
}
