import assert from 'node:assert/strict';
import test from 'node:test';
import {
  closeChannelManagedPoll,
  createChannelManagedPoll,
  deleteChannelManagedPoll,
  getChannelManagedPoll,
  getChannelManagedPollVoters,
  getChannelManagedPolls,
  publishChannelManagedPoll,
  refreshChannelManagedPollPublication,
  resetChannelManagedPollPublication,
  updateChannelManagedPoll,
} from '../src/lib/api/channel-polls-client';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';

test('preview channel polls support history, voters, and draft lifecycle', async () => {
  const api = createPreviewApiTransport();
  const initial = await getChannelManagedPolls(api, 'preview-channel');
  const firstPage = await getChannelManagedPolls(api, 'preview-channel', { limit: 1 });

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
    createChannelManagedPoll(api, 'preview-channel', {
      question: 'Второй текущий опрос?',
      visibility: 'ANONYMOUS',
      options: [{ text: 'Да' }, { text: 'Нет' }],
    }),
    /Сначала завершите текущий опрос/u,
  );

  const voters = await getChannelManagedPollVoters(api, 'preview-channel', 'poll-channel-active', {
    limit: 2,
  });
  assert.equal(voters.items.length, 2);
  assert.equal(typeof voters.nextCursor, 'string');

  const repaired = await refreshChannelManagedPollPublication(
    api,
    'preview-channel',
    'poll-channel-closed',
  );
  assert.equal(repaired.renderRepairNeeded, false);
  await assert.rejects(
    resetChannelManagedPollPublication(api, 'preview-channel', 'poll-channel-active'),
    /Публикация не требует сброса/u,
  );

  await closeChannelManagedPoll(api, 'preview-channel', 'poll-channel-active');

  const created = await createChannelManagedPoll(api, 'preview-channel', {
    question: '**Какой день** удобнее?',
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
      { id: 'client-option-1', text: 'Пятница' },
      { id: 'client-option-2', text: 'Суббота' },
    ],
  });
  assert.equal(created.status, 'DRAFT');
  assert.equal(
    created.options.some((option) => option.id.startsWith('client-option-')),
    false,
  );
  assert.equal(created.questionFormat, 'markdown');
  assert.equal(created.images.length, 1);

  const createdSummary = (await getChannelManagedPolls(api, 'preview-channel')).items.find(
    (poll) => poll.id === created.id,
  );
  assert.equal(createdSummary?.imageCount, 1);
  assert.equal('images' in (createdSummary ?? {}), false);

  const createdDetails = await getChannelManagedPoll(api, 'preview-channel', created.id);
  assert.deepEqual(createdDetails.images, created.images);

  const legacyUpdated = await updateChannelManagedPoll(api, 'preview-channel', created.id, {
    question: 'Когда встречаемся?',
    visibility: 'ANONYMOUS',
    options: created.options.map((option) => ({ id: option.id, text: option.text })),
  });
  assert.equal(legacyUpdated.questionFormat, 'markdown');
  assert.deepEqual(legacyUpdated.images, created.images);

  const updated = await updateChannelManagedPoll(api, 'preview-channel', created.id, {
    question: 'Когда встречаемся?',
    questionFormat: 'plain',
    visibility: 'OPEN',
    images: [],
    options: created.options.map((option) => ({ id: option.id, text: option.text })),
  });
  assert.equal(updated.visibility, 'OPEN');
  assert.equal(updated.questionFormat, 'plain');
  assert.equal(updated.imageCount, 0);

  const published = await publishChannelManagedPoll(api, 'preview-channel', created.id);
  assert.equal(published.status, 'ACTIVE');
  const closed = await closeChannelManagedPoll(api, 'preview-channel', created.id);
  assert.equal(closed.status, 'CLOSED');

  const disposable = await createChannelManagedPoll(api, 'preview-channel', {
    question: 'Удалить этот черновик?',
    visibility: 'ANONYMOUS',
    options: [{ text: 'Да' }, { text: 'Нет' }],
  });
  await deleteChannelManagedPoll(api, 'preview-channel', disposable.id);
  const final = await getChannelManagedPolls(api, 'preview-channel');
  assert.equal(
    final.items.some((poll) => poll.id === disposable.id),
    false,
  );
});
