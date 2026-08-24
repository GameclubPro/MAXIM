export type CommercialDecisionBand = 'LOW' | 'MEDIUM' | 'HIGH';

export type {
  ProfanityCategory,
  ProfanityDetectionDecision,
  ProfanityEvidence,
  ProfanityMatchKind,
  ProfanityRolloutMode,
  ProfanitySensitivity,
  ProfanityViolationMetadata,
} from './profanity/profanity.types';

export type CommercialSubtype =
  | 'CHANNEL_PLACEMENT'
  | 'PROPERTY_AGENT'
  | 'PROPERTY_COMMERCIAL'
  | 'RECRUITMENT'
  | 'INFO_PRODUCT'
  | 'BUYOUT'
  | 'SERVICES'
  | 'GOODS_RETAIL'
  | 'GOODS'
  | 'GROUP_PROMOTION'
  | 'GENERIC';

export type DuplicateAction = 'WARN' | 'MUTE' | 'BAN';

export type DuplicateFingerprintType =
  | 'exact'
  | 'content'
  | 'near'
  | 'link'
  | 'phone'
  | 'image'
  | 'image_set';

export type DuplicateDecision = {
  action: DuplicateAction;
  count: number;
  threshold: number;
  windowSec: number;
  hash: string;
  fingerprintType: DuplicateFingerprintType;
  nextAction: DuplicateAction | null;
  metadata?: Record<string, unknown>;
};

export type DuplicateHit = {
  count: number;
  windowSec: number;
  hash: string;
  fingerprintType: DuplicateFingerprintType;
  metadata?: Record<string, unknown>;
};

export type RuleViolation = {
  ruleCode: string;
  score: number;
  reason: string;
  metadata?: Record<string, unknown>;
};

export type DetectionResult = {
  violations: RuleViolation[];
  duplicateHit?: DuplicateHit;
  duplicateDecision?: DuplicateDecision;
  duplicateStateSkipped?: boolean;
};
