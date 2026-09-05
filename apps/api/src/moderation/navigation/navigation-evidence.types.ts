export type NavigationEvidenceKind = 'external_url' | 'max_entity' | 'mini_app' | 'profile_mention';

export type NavigationEvidenceCarrier =
  | 'link_button'
  | 'link_markup'
  | 'chat_button'
  | 'open_app_button'
  | 'plain_text'
  | 'share_attachment'
  | 'user_mention_markup';

export type NavigationEvidenceProvenance = 'direct' | 'visible_forward';

export type NavigationEvidenceCertainty = 'platform_declared' | 'text_inferred';

export type NavigationEvidenceEnforcement = 'eligible' | 'shadow_only';

export type NavigationRangeStatus = 'invalid' | 'missing' | 'not_applicable' | 'valid';

export type NavigationRangeInvalidReason =
  | 'non_integer'
  | 'non_positive_length'
  | 'out_of_bounds'
  | 'splits_surrogate_pair';

export type NavigationEvidenceRange = {
  status: NavigationRangeStatus;
  from: number | null;
  length: number | null;
  end: number | null;
  visibleText: string | null;
  invalidReason: NavigationRangeInvalidReason | null;
};

export type NavigationEvidence = {
  kind: NavigationEvidenceKind;
  carrier: NavigationEvidenceCarrier;
  provenance: NavigationEvidenceProvenance;
  certainty: NavigationEvidenceCertainty;
  enforcement: NavigationEvidenceEnforcement;
  sourcePath: string;
  range: NavigationEvidenceRange;
  contentFingerprint: string;
  navigationFingerprint?: string;
};

export type NavigationTargetEvidence = {
  kind: NavigationEvidenceKind;
  target: string;
  normalizedTarget: string;
  enforceable: boolean;
  origins: NavigationEvidence[];
  allowlistAliases?: NavigationTargetAlias[];
};

export type NavigationTargetAlias = {
  kind: NavigationEvidenceKind;
  target: string;
  normalizedTarget: string;
};

export type NavigationDiagnosticCategory = 'ambiguous' | 'invalid' | 'unknown';

export type NavigationDiagnosticCode =
  | 'AMBIGUOUS_FORWARD_PAYLOAD'
  | 'AMBIGUOUS_MESSAGE_PATH'
  | 'AMBIGUOUS_TARGET'
  | 'PLAIN_TEXT_SOURCE_MISSING'
  | 'INVALID_UTF16_RANGE'
  | 'INVALID_NAVIGATION_TARGET'
  | 'MESSAGE_VIEW_NOT_FOUND'
  | 'MISSING_UTF16_RANGE'
  | 'UNKNOWN_ATTACHMENT_TYPE'
  | 'UNKNOWN_BUTTON_TYPE'
  | 'UNKNOWN_LINK_TYPE'
  | 'UNKNOWN_MARKUP_TYPE';

export type NavigationDiagnostic = {
  category: NavigationDiagnosticCategory;
  code: NavigationDiagnosticCode;
  sourcePath: string;
  provenance: NavigationEvidenceProvenance | null;
  contentFingerprint: string | null;
  rawType: string | null;
};

export type NavigationExtractionResult = {
  targets: NavigationTargetEvidence[];
  diagnostics: NavigationDiagnostic[];
};

export type MaxNavigationMarkupView = {
  path: string;
  type: string | null;
  from: unknown;
  length: unknown;
  url: unknown;
  userLink: unknown;
  userId: unknown;
};

export type MaxNavigationButtonView = {
  path: string;
  type: string | null;
  url: unknown;
  webApp: unknown;
  contactId: unknown;
  chatTitle: unknown;
  chatDescription: unknown;
  startPayload: unknown;
  uuid: unknown;
};

export type MaxNavigationAttachmentKind =
  | 'inline_keyboard'
  | 'known_non_navigation'
  | 'share'
  | 'unknown';

export type MaxNavigationAttachmentView = {
  path: string;
  kind: MaxNavigationAttachmentKind;
  rawType: string | null;
  payloadUrl: unknown;
  buttons: MaxNavigationButtonView[];
};

export type MaxNavigationContentView = {
  path: string;
  provenance: NavigationEvidenceProvenance;
  text: string;
  markup: MaxNavigationMarkupView[];
  attachments: MaxNavigationAttachmentView[];
  nonNavigationUrls: string[];
  contentFingerprint: string;
  navigationFingerprint: string;
};

export type MaxNavigationMessageView = {
  messagePath: string | null;
  direct: MaxNavigationContentView | null;
  visibleForward: MaxNavigationContentView | null;
  replyStopped: boolean;
  diagnostics: NavigationDiagnostic[];
};

export type PlainTextLinkCandidate = {
  provenance: NavigationEvidenceProvenance;
  target: string;
  from: number;
  length: number;
  sourcePath?: string;
};

export type NavigationExtractionOptions = {
  plainTextCandidates?: readonly PlainTextLinkCandidate[];
};
