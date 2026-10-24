import type {
  StatsAudienceValue,
  StatsExternalAudienceValue,
  StatsReachValue,
  StatsRecentReachValue,
  StatsPublicationValue,
  StatsMembershipValue,
  StatsProducer,
  StatsDayKey,
  StatsCoverage,
  StatsHealth,
  StatsSourceDependency,
} from '@maxim/contracts/statistics-central';

export type StatsValue =
  | StatsAudienceValue
  | StatsExternalAudienceValue
  | StatsReachValue
  | StatsRecentReachValue
  | StatsPublicationValue
  | StatsMembershipValue;
export type StatsCandidate = {
  producer: StatsProducer;
  scope: StatsDayKey;
  value: StatsValue;
  coverage: StatsCoverage;
  health: StatsHealth;
  dependencies?: StatsSourceDependency[];
  unavailableReason?: 'NUMERIC_LIMIT';
};
