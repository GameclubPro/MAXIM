import { COMMERCIAL_REAL_WORLD_POSITIVE_CASES } from './commercial-real-world.fixture';

export const COMMERCIAL_GRAY_CASES = COMMERCIAL_REAL_WORLD_POSITIVE_CASES.filter(
  (item) => item.reviewRecommended === true || item.requireClassifier === true,
);

