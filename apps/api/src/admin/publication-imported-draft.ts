import { PublicationAudienceSelection, PublicationLifecycle } from '../prisma/prisma-client';

export function isImportedEmptyPublicationDraft(publication: {
  lifecycle: PublicationLifecycle;
  audienceSelection: PublicationAudienceSelection;
  targets: readonly unknown[];
}): boolean {
  return (
    publication.lifecycle === PublicationLifecycle.DRAFT &&
    publication.audienceSelection === PublicationAudienceSelection.SELECTED &&
    publication.targets.length === 0
  );
}
