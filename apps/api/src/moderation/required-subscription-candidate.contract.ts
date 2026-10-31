import type { RuleFollowupSanctionJournal } from './moderation-rule-followup-sanction';
import type {
  RequiredSubscriptionCandidateRow,
  RequiredSubscriptionCandidateStore,
} from './required-subscription-candidate.store';

export type RequiredSubscriptionCandidateAttempt = {
  row: RequiredSubscriptionCandidateRow;
  store: RequiredSubscriptionCandidateStore;
  journal: RuleFollowupSanctionJournal;
};
