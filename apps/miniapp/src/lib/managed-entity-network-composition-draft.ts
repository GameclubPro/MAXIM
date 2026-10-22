import type {
  ManagedEntityNetworkCompositionChange,
  ManagedEntityNetworkEntry,
} from '@maxim/contracts';
import { getHomeEntityFavoriteTypes } from './home-entity-favorites';
import type { HomeEntityFavoritesSession } from './home-entity-favorites-session';
import type {
  HomeEntityFavoritesTypeSnapshot,
  ManagedEntityNetworkKey,
} from './home-entity-favorites-types';

export type ManagedEntityNetworkCompositionDraftPhase =
  | 'editing'
  | 'saving'
  | 'review-required'
  | 'saved-refresh-pending';

export class ManagedEntityNetworkCompositionDraft {
  private changes = new Map<string, ManagedEntityNetworkCompositionChange>();
  private baselineEpoch: number;
  private reviewAfterRead: number;
  private phase: ManagedEntityNetworkCompositionDraftPhase = 'editing';
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private cachedRevision = -1;
  private cachedType: HomeEntityFavoritesTypeSnapshot | null = null;
  private cached!: {
    changes: readonly ManagedEntityNetworkCompositionChange[];
    dirty: boolean;
    count: number;
    compositionChanged: boolean;
    phase: ManagedEntityNetworkCompositionDraftPhase;
  };

  constructor(
    private readonly session: HomeEntityFavoritesSession,
    private readonly key: ManagedEntityNetworkKey,
  ) {
    this.baselineEpoch = session.getSnapshot().byType[key.entityType].compositionEpoch;
    this.reviewAfterRead = session.getAssignmentReadSequence(key.entityType);
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    const unsubscribe = this.session.subscribe(listener);
    return () => {
      this.listeners.delete(listener);
      unsubscribe();
    };
  };
  private notify() {
    this.revision += 1;
    this.listeners.forEach((listener) => listener());
  }
  getSnapshot = () => {
    const current = this.session.getSnapshot().byType[this.key.entityType];
    const epoch = current.compositionEpoch;
    if (this.cachedRevision === this.revision && this.cachedType === current) return this.cached;
    this.cachedType = current;
    this.cachedRevision = this.revision;
    const compositionChanged = this.changes.size > 0 && epoch !== this.baselineEpoch;
    this.cached = {
      changes: [...this.changes.values()],
      dirty: this.changes.size > 0,
      count: this.changes.size,
      compositionChanged,
      phase:
        compositionChanged && this.phase === 'editing'
          ? 'review-required'
          : this.phase === 'saved-refresh-pending' &&
              current.assignmentsComplete &&
              !current.catalogueStale &&
              current.status === 'ready'
            ? 'editing'
            : this.phase,
    };
    return this.cached;
  };
  stage = (
    entity: Pick<ManagedEntityNetworkEntry, 'id' | 'favoriteType'>,
    favoriteType: ManagedEntityNetworkCompositionChange['favoriteType'],
  ) => {
    if (this.phase === 'saving') return;
    if (this.changes.size === 0) {
      this.baselineEpoch = this.session.getSnapshot().byType[this.key.entityType].compositionEpoch;
      this.reviewAfterRead = this.session.getAssignmentReadSequence(this.key.entityType);
      this.phase = 'editing';
    }
    const existing = this.changes.get(entity.id);
    const expectedFavoriteType = existing ? existing.expectedFavoriteType : entity.favoriteType;
    if (favoriteType === expectedFavoriteType) this.changes.delete(entity.id);
    else {
      if (!this.changes.has(entity.id) && this.changes.size >= 500)
        throw new Error('За одно сохранение можно изменить до 500 сообществ.');
      this.changes.set(entity.id, { entityId: entity.id, expectedFavoriteType, favoriteType });
    }
    this.notify();
  };
  discard = () => {
    if (this.phase === 'saving') return;
    this.changes.clear();
    this.phase = 'editing';
    this.baselineEpoch = this.session.getSnapshot().byType[this.key.entityType].compositionEpoch;
    this.notify();
  };
  save = async () => {
    const snapshot = this.getSnapshot();
    if (!snapshot.dirty || snapshot.phase === 'saving') return null;
    if (snapshot.phase === 'review-required')
      throw new Error('Сначала проверьте актуальный состав сетки.');
    this.phase = 'saving';
    this.notify();
    try {
      const result = await this.session.commitComposition({
        entityType: this.key.entityType,
        changes: snapshot.changes,
      });
      this.changes.clear();
      this.baselineEpoch = this.session.getSnapshot().byType[this.key.entityType].compositionEpoch;
      this.phase = result.refresh === 'pending' ? 'saved-refresh-pending' : 'editing';
      this.notify();
      return result;
    } catch (error) {
      this.reviewAfterRead = this.session.getAssignmentReadSequence(this.key.entityType);
      this.phase = 'review-required';
      this.notify();
      // Explicit reads are safe even after uncertain writes; desired changes stay intact.
      void this.session
        .refreshAssignments(this.key.entityType)
        .then(() => this.session.refreshCatalogue(this.key.entityType))
        .catch(() => undefined);
      throw error;
    }
  };
  rebaseAfterReview = () => {
    const snapshot = this.session.getSnapshot();
    const type = snapshot.byType[this.key.entityType];
    if (
      this.phase === 'saving' ||
      !type.assignmentsComplete ||
      type.status === 'loading' ||
      this.session.getAssignmentReadSequence(this.key.entityType) <= this.reviewAfterRead
    )
      throw new Error('Сначала обновите и проверьте состав сетки.');
    for (const [id, change] of this.changes) {
      const expectedFavoriteType =
        getHomeEntityFavoriteTypes(snapshot.assignments, this.key.entityType, id)[0] ?? null;
      if (expectedFavoriteType === change.favoriteType) this.changes.delete(id);
      else this.changes.set(id, { ...change, expectedFavoriteType });
    }
    this.baselineEpoch = type.compositionEpoch;
    this.phase = 'editing';
    this.notify();
  };
}
