import {
  NATIVE_TESSERACT_MAX_WORD_LENGTH,
  NATIVE_TESSERACT_MAX_WORDS,
  parseNativeTesseractTsv,
} from './native-tesseract-tsv';

const HEADER =
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';

describe('parseNativeTesseractTsv', () => {
  it('builds stable text, confidence, line and word spans', () => {
    const parsed = parseNativeTesseractTsv(
      [
        HEADER,
        '1\t1\t0\t0\t0\t0\t0\t0\t300\t120\t-1\t',
        '5\t1\t1\t1\t1\t1\t10\t20\t90\t24\t95.5\tРемонт',
        '5\t1\t1\t1\t1\t2\t110\t20\t80\t24\t85.25\tокон',
        '5\t1\t1\t1\t2\t1\t15\t60\t100\t25\t70\tСкидка',
      ].join('\n'),
    );

    expect(parsed).toEqual({
      text: 'Ремонт окон\nСкидка',
      aggregateConfidence: 83.38,
      truncated: false,
      words: [
        {
          text: 'Ремонт',
          start: 0,
          end: 6,
          confidence: 95.5,
          lineIndex: 0,
          boundingBox: { left: 10, top: 20, width: 90, height: 24 },
        },
        {
          text: 'окон',
          start: 7,
          end: 11,
          confidence: 85.25,
          lineIndex: 0,
          boundingBox: { left: 110, top: 20, width: 80, height: 24 },
        },
        {
          text: 'Скидка',
          start: 12,
          end: 18,
          confidence: 70,
          lineIndex: 1,
          boundingBox: { left: 15, top: 60, width: 100, height: 25 },
        },
      ],
      lines: [
        {
          text: 'Ремонт окон',
          start: 0,
          end: 11,
          confidence: 91.4,
          wordStartIndex: 0,
          wordEndIndex: 2,
          boundingBox: { left: 10, top: 20, width: 180, height: 24 },
        },
        {
          text: 'Скидка',
          start: 12,
          end: 18,
          confidence: 70,
          wordStartIndex: 2,
          wordEndIndex: 3,
          boundingBox: { left: 15, top: 60, width: 100, height: 25 },
        },
      ],
    });
  });

  it('returns a valid no-text payload when TSV has no word rows', () => {
    expect(parseNativeTesseractTsv(`${HEADER}\n`)).toEqual({
      text: '',
      aggregateConfidence: null,
      words: [],
      lines: [],
      truncated: false,
    });
  });

  it('bounds text without splitting a surrogate pair', () => {
    const parsed = parseNativeTesseractTsv(
      `${HEADER}\n5\t1\t1\t1\t1\t1\t0\t0\t20\t20\t90\tA😀B`,
      2,
    );

    expect(parsed.text).toBe('A');
    expect(parsed.words[0]).toMatchObject({ text: 'A', start: 0, end: 1 });
    expect(parsed.truncated).toBe(true);
  });

  it('emits the exact bounded word population and marks additional rows truncated', () => {
    const rows = Array.from(
      { length: NATIVE_TESSERACT_MAX_WORDS + 1 },
      (_, index) => `5\t1\t1\t1\t1\t${index + 1}\t${index}\t0\t1\t1\t90\ta`,
    );
    const exact = parseNativeTesseractTsv(
      [HEADER, ...rows.slice(0, NATIVE_TESSERACT_MAX_WORDS)].join('\n'),
    );
    const overflow = parseNativeTesseractTsv([HEADER, ...rows].join('\n'));

    expect(exact.words).toHaveLength(NATIVE_TESSERACT_MAX_WORDS);
    expect(exact.truncated).toBe(false);
    expect(overflow.words).toHaveLength(NATIVE_TESSERACT_MAX_WORDS);
    expect(overflow.truncated).toBe(true);
  });

  it('bounds a single OCR word before it crosses the UDS/cache contract', () => {
    const parsed = parseNativeTesseractTsv(
      `${HEADER}\n5\t1\t1\t1\t1\t1\t0\t0\t20\t20\t90\t${'a'.repeat(
        NATIVE_TESSERACT_MAX_WORD_LENGTH + 1,
      )}`,
    );

    expect(parsed.words[0]?.text).toHaveLength(NATIVE_TESSERACT_MAX_WORD_LENGTH);
    expect(parsed.truncated).toBe(true);
  });

  it('rejects arbitrary or malformed output instead of treating it as no text', () => {
    expect(() => parseNativeTesseractTsv('not tsv')).toThrow('header is invalid');
    expect(() => parseNativeTesseractTsv(`${HEADER}\n\0`)).toThrow('NUL');
  });
});
