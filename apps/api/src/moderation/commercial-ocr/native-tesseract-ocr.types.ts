export const NATIVE_TESSERACT_PAGE_SEGMENTATION_MODES = [6, 11] as const;

export type NativeTesseractPageSegmentationMode =
  (typeof NATIVE_TESSERACT_PAGE_SEGMENTATION_MODES)[number];

export type CommercialOcrBoundingBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/** Offsets are UTF-16 code-unit offsets into the result text; end is exclusive. */
export type CommercialOcrWordSpan = {
  text: string;
  start: number;
  end: number;
  confidence: number;
  lineIndex: number;
  boundingBox: CommercialOcrBoundingBox;
};

/** Offsets and word indexes are half-open ranges. */
export type CommercialOcrLineSpan = {
  text: string;
  start: number;
  end: number;
  confidence: number;
  wordStartIndex: number;
  wordEndIndex: number;
  boundingBox: CommercialOcrBoundingBox;
};

export type NativeTesseractRecognizeOptions = {
  psm?: NativeTesseractPageSegmentationMode;
  passLabel?: string;
  deadlineAtMs?: number;
};

export type NativeTesseractRecognizedResult = {
  ok: true;
  status: 'recognized' | 'no_text';
  passLabel: string;
  psm: NativeTesseractPageSegmentationMode;
  text: string;
  aggregateConfidence: number | null;
  words: CommercialOcrWordSpan[];
  lines: CommercialOcrLineSpan[];
  truncated: boolean;
  durationMs: number;
};

export type NativeTesseractFailureReason =
  | 'invalid_input'
  | 'capacity_exhausted'
  | 'timeout'
  | 'worker_unavailable'
  | 'tesseract_failed'
  | 'output_limit'
  | 'invalid_output'
  | 'shutting_down';

export type NativeTesseractFailedOpenResult = {
  ok: false;
  status: 'failed_open';
  passLabel: string;
  psm: NativeTesseractPageSegmentationMode;
  reason: NativeTesseractFailureReason;
  durationMs: number;
};

export type NativeTesseractOcrResult =
  | NativeTesseractRecognizedResult
  | NativeTesseractFailedOpenResult;
