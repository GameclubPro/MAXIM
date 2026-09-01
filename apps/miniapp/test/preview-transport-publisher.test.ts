import assert from 'node:assert/strict';
import test from 'node:test';
import { getPublication } from '../src/lib/api/publication-client';
import {
  listPublisherSuggestions,
  reviewPublisherSuggestion,
} from '../src/lib/api/publisher-suggestions-client';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';

test('preview publisher queue has one pending image-only suggestion', async () => {
  const api = createPreviewApiTransport({ search: '?publisherSuggestions=large' });
  const response = await listPublisherSuggestions(api, 'preview-channel', {
    view: 'pending',
    limit: 100,
  });
  const imageOnlySuggestions = response.items.filter(
    (suggestion) => suggestion.text.trim() === '' && suggestion.imageCount > 0,
  );

  assert.equal(imageOnlySuggestions.length, 1);
  assert.equal(imageOnlySuggestions[0]?.reviewStatus, 'pending');
  assert.equal(imageOnlySuggestions[0]?.authorDisplayName, 'Автор 2');
  assert.equal(imageOnlySuggestions[0]?.imageCount, 1);

  const imageOnlySuggestion = imageOnlySuggestions[0];
  assert.ok(imageOnlySuggestion);
  const reviewed = await reviewPublisherSuggestion(api, 'preview-channel', imageOnlySuggestion.id, {
    action: 'draft',
  });
  assert.ok(reviewed.suggestion.publicationId);
  const publication = await getPublication(api, reviewed.suggestion.publicationId);
  assert.equal(publication.content.text, '');
  assert.equal(publication.content.media.length, 1);
  assert.equal(publication.content.media[0]?.type, 'image');
  assert.equal(publication.content.media[0]?.fileName, 'suggestion-photo-1.png');
});
