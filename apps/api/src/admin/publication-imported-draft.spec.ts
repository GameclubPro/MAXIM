import { PublicationAudienceSelection, PublicationLifecycle } from '../prisma/prisma-client';
import { isImportedEmptyPublicationDraft } from './publication-imported-draft';

describe('isImportedEmptyPublicationDraft', () => {
  it('recognizes only a selected-audience draft before its first target choice', () => {
    expect(
      isImportedEmptyPublicationDraft({
        lifecycle: PublicationLifecycle.DRAFT,
        audienceSelection: PublicationAudienceSelection.SELECTED,
        targets: [],
      }),
    ).toBe(true);

    expect(
      isImportedEmptyPublicationDraft({
        lifecycle: PublicationLifecycle.ACTIVE,
        audienceSelection: PublicationAudienceSelection.SELECTED,
        targets: [],
      }),
    ).toBe(false);
    expect(
      isImportedEmptyPublicationDraft({
        lifecycle: PublicationLifecycle.DRAFT,
        audienceSelection: PublicationAudienceSelection.ALL_MANAGED,
        targets: [],
      }),
    ).toBe(false);
    expect(
      isImportedEmptyPublicationDraft({
        lifecycle: PublicationLifecycle.DRAFT,
        audienceSelection: PublicationAudienceSelection.SELECTED,
        targets: [{ targetChatId: 'chat-1' }],
      }),
    ).toBe(false);
  });
});
