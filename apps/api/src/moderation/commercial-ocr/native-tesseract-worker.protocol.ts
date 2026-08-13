import type {
  CommercialOcrLineSpan,
  CommercialOcrWordSpan,
  NativeTesseractFailureReason,
  NativeTesseractPageSegmentationMode,
} from './native-tesseract-ocr.types';

export type NativeTesseractWorkerRecognizeRequest = {
  type: 'recognize';
  jobId: string;
  image: Buffer;
  psm: NativeTesseractPageSegmentationMode;
  timeoutMs: number;
};

export type NativeTesseractWorkerShutdownRequest = {
  type: 'shutdown';
};

export type NativeTesseractWorkerRequest =
  | NativeTesseractWorkerRecognizeRequest
  | NativeTesseractWorkerShutdownRequest;

export type NativeTesseractWorkerPayload = {
  text: string;
  aggregateConfidence: number | null;
  words: CommercialOcrWordSpan[];
  lines: CommercialOcrLineSpan[];
  truncated: boolean;
};

export type NativeTesseractWorkerReadyResponse = {
  type: 'ready';
};

export type NativeTesseractWorkerResultResponse = {
  type: 'result';
  jobId: string;
  retireWorker: boolean;
  result:
    | { ok: true; payload: NativeTesseractWorkerPayload }
    | {
        ok: false;
        reason: Extract<
          NativeTesseractFailureReason,
          'timeout' | 'tesseract_failed' | 'output_limit' | 'invalid_output'
        >;
      };
};

export type NativeTesseractWorkerResponse =
  | NativeTesseractWorkerReadyResponse
  | NativeTesseractWorkerResultResponse;
