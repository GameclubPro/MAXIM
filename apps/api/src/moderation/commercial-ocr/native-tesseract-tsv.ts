import type {
  CommercialOcrBoundingBox,
  CommercialOcrLineSpan,
  CommercialOcrWordSpan,
} from './native-tesseract-ocr.types';

export const NATIVE_TESSERACT_MAX_TEXT_LENGTH = 8_000;

export type ParsedNativeTesseractTsv = {
  text: string;
  aggregateConfidence: number | null;
  words: CommercialOcrWordSpan[];
  lines: CommercialOcrLineSpan[];
  truncated: boolean;
};

type TsvWord = {
  lineKey: string;
  text: string;
  confidence: number;
  boundingBox: CommercialOcrBoundingBox;
};

export function parseNativeTesseractTsv(
  tsv: string,
  maxTextLength = NATIVE_TESSERACT_MAX_TEXT_LENGTH,
): ParsedNativeTesseractTsv {
  if (!Number.isSafeInteger(maxTextLength) || maxTextLength <= 0) {
    throw new Error('maxTextLength must be a positive integer');
  }
  if (tsv.includes('\0')) {
    throw new Error('Tesseract TSV contains a NUL byte');
  }

  const firstRow = tsv
    .replace(/^\uFEFF/u, '')
    .split(/\r?\n/u)
    .find((row) => row.trim());
  const header = firstRow?.split('\t').map((column) => column.trim().toLowerCase());
  if (
    !header ||
    header.length < 12 ||
    header[0] !== 'level' ||
    header[10] !== 'conf' ||
    header[11] !== 'text'
  ) {
    throw new Error('Tesseract TSV header is invalid');
  }

  const sourceWords = readTsvWords(tsv);
  const words: CommercialOcrWordSpan[] = [];
  const lines: CommercialOcrLineSpan[] = [];
  let text = '';
  let truncated = false;
  let sourceIndex = 0;

  while (sourceIndex < sourceWords.length && text.length < maxTextLength) {
    const lineKey = sourceWords[sourceIndex].lineKey;
    const lineWords: TsvWord[] = [];
    while (sourceIndex < sourceWords.length && sourceWords[sourceIndex].lineKey === lineKey) {
      lineWords.push(sourceWords[sourceIndex]);
      sourceIndex += 1;
    }

    const lineSeparator = text.length > 0 ? '\n' : '';
    if (text.length + lineSeparator.length >= maxTextLength) {
      truncated = true;
      break;
    }
    text += lineSeparator;
    const lineStart = text.length;
    const wordStartIndex = words.length;
    const acceptedLineWords: TsvWord[] = [];

    for (const sourceWord of lineWords) {
      const wordSeparator = acceptedLineWords.length > 0 ? ' ' : '';
      const available = maxTextLength - text.length - wordSeparator.length;
      if (available <= 0) {
        truncated = true;
        break;
      }
      const acceptedText = truncateUtf16Safely(sourceWord.text, available);
      if (acceptedText.length === 0) {
        truncated = true;
        break;
      }
      text += wordSeparator;
      const start = text.length;
      text += acceptedText;
      const acceptedWord = { ...sourceWord, text: acceptedText };
      acceptedLineWords.push(acceptedWord);
      words.push({
        text: acceptedText,
        start,
        end: text.length,
        confidence: sourceWord.confidence,
        lineIndex: lines.length,
        boundingBox: sourceWord.boundingBox,
      });
      if (acceptedText.length !== sourceWord.text.length) {
        truncated = true;
        break;
      }
    }

    if (acceptedLineWords.length === 0) {
      text = text.slice(0, lineStart - lineSeparator.length);
      break;
    }
    lines.push({
      text: text.slice(lineStart),
      start: lineStart,
      end: text.length,
      confidence: weightedConfidence(acceptedLineWords),
      wordStartIndex,
      wordEndIndex: words.length,
      boundingBox: unionBoundingBoxes(acceptedLineWords.map((word) => word.boundingBox)),
    });

    if (truncated) {
      break;
    }
  }

  if (sourceIndex < sourceWords.length) {
    truncated = true;
  }

  return {
    text,
    aggregateConfidence: words.length > 0 ? weightedConfidence(words) : null,
    words,
    lines,
    truncated,
  };
}

function readTsvWords(tsv: string): TsvWord[] {
  const words: TsvWord[] = [];
  const rows = tsv.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row.trim()) {
      continue;
    }
    const columns = row.split('\t');
    if (index === 0 && columns[0]?.trim().toLowerCase() === 'level') {
      continue;
    }
    if (columns.length < 12 || columns[0] !== '5') {
      continue;
    }

    const page = parseNonNegativeInteger(columns[1]);
    const block = parseNonNegativeInteger(columns[2]);
    const paragraph = parseNonNegativeInteger(columns[3]);
    const line = parseNonNegativeInteger(columns[4]);
    const left = parseNonNegativeInteger(columns[6]);
    const top = parseNonNegativeInteger(columns[7]);
    const width = parseNonNegativeInteger(columns[8]);
    const height = parseNonNegativeInteger(columns[9]);
    const rawConfidence = Number(columns[10]);
    const text = normalizeWord(columns.slice(11).join('\t'));
    if (
      page === null ||
      block === null ||
      paragraph === null ||
      line === null ||
      left === null ||
      top === null ||
      width === null ||
      height === null ||
      width === 0 ||
      height === 0 ||
      !Number.isFinite(rawConfidence) ||
      !text
    ) {
      continue;
    }
    words.push({
      lineKey: `${page}:${block}:${paragraph}:${line}`,
      text,
      confidence: roundConfidence(Math.max(0, Math.min(100, rawConfidence))),
      boundingBox: { left, top, width, height },
    });
  }
  return words;
}

function normalizeWord(value: string): string {
  return (
    value
      // Tesseract TSV is untrusted process output; remove embedded ASCII controls before scoring.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
  );
}

function parseNonNegativeInteger(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function weightedConfidence(words: readonly Pick<TsvWord, 'text' | 'confidence'>[]): number {
  let weightedTotal = 0;
  let totalWeight = 0;
  for (const word of words) {
    const weight = Math.max(1, Array.from(word.text).length);
    weightedTotal += word.confidence * weight;
    totalWeight += weight;
  }
  return roundConfidence(weightedTotal / totalWeight);
}

function roundConfidence(value: number): number {
  return Math.round(value * 100) / 100;
}

function unionBoundingBoxes(boxes: readonly CommercialOcrBoundingBox[]): CommercialOcrBoundingBox {
  const left = Math.min(...boxes.map((box) => box.left));
  const top = Math.min(...boxes.map((box) => box.top));
  const right = Math.max(...boxes.map((box) => box.left + box.width));
  const bottom = Math.max(...boxes.map((box) => box.top + box.height));
  return { left, top, width: right - left, height: bottom - top };
}

function truncateUtf16Safely(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  let truncated = value.slice(0, maxLength);
  const finalCodeUnit = truncated.charCodeAt(truncated.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    truncated = truncated.slice(0, -1);
  }
  return truncated;
}
