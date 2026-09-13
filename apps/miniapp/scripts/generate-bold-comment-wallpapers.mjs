import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const width = 780;
const height = 1200;
const destination = fileURLToPath(new URL('../src/assets/wallpapers/', import.meta.url));

function svg(background, content) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="600" viewBox="0 0 390 600"><rect width="390" height="600" fill="${background}"/>${content}</svg>`;
}

function neon() {
  const traces = [
    ['#69e9ed', 'M-30 55H33Q49 55 49 71V131Q49 144 62 157L107 202Q119 214 119 232V300'],
    ['#c7ff62', 'M-24 96H4Q18 96 18 110V171Q18 185 30 197L73 240Q84 251 84 269V341'],
    ['#ff8fbf', 'M420 546H364Q348 546 348 530V462Q348 448 336 436L291 391Q278 378 278 362V303'],
    ['#69e9ed', 'M415 501H388Q378 501 378 491V440Q378 426 366 414L328 376Q316 364 316 350V268'],
  ];
  const grid =
    '<path d="M0 40H390M0 120H390M0 200H390M0 280H390M0 360H390M0 440H390M0 520H390M40 0V600M120 0V600M200 0V600M280 0V600M360 0V600" fill="none" stroke="#6b989b" stroke-width="0.5" opacity="0.08"/>';
  const drawing = traces
    .map(([color, d]) =>
      [
        [18, 0.022],
        [10, 0.045],
        [5, 0.09],
        [2, 0.34],
        [0.85, 0.92],
      ]
        .map(
          ([strokeWidth, opacity]) =>
            `<path d="${d}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"/>`,
        )
        .join(''),
    )
    .join('');
  const details =
    '<path d="M38 430v26l14 14h27M306 120h25l13 13v28M143 69h19m-19 6h9" fill="none" stroke="#78b4b7" stroke-width="0.8" opacity="0.4"/>';
  return Buffer.from(svg('#0b1113', grid + drawing + details));
}

function avant(dark) {
  const background = dark ? '#1b1c22' : '#f3f4f8';
  const blue = dark ? '#3044a3' : '#3155ca';
  const coral = dark ? '#c1786c' : '#ec927f';
  const yellow = dark ? '#c2a961' : '#f1ce69';
  const line = dark ? '#7c83a0' : '#9fa9c5';
  return Buffer.from(
    svg(
      background,
      `
    <path d="M-50-10H105L54 156-30 225Z" fill="${blue}"/>
    <path d="M-45 100L74-24H146L-45 199Z" fill="${coral}"/>
    <path d="M-20 194L111 51M-20 205L117 56M-20 216L123 61" fill="none" stroke="${line}" stroke-width="0.8"/>
    <path d="M431 297L272 546L322 623H431Z" fill="${yellow}"/>
    <path d="M414 403L334 526L241 624H325L422 515Z" fill="${blue}"/>
    <path d="M284 627L391 504M275 620L382 497M266 613L373 490" fill="none" stroke="${line}" stroke-width="0.8"/>
    <path d="M21 381L43 359H70M23 388L48 363M286 178h43l22 22v34" fill="none" stroke="${line}" stroke-width="0.7" opacity="0.55"/>
  `,
    ),
  );
}

function obsidian() {
  const pixels = Buffer.alloc(width * height * 3);
  const elevation = (x, y) => {
    const phase =
      x * 0.036 + y * 0.011 + 2 * Math.sin(y * 0.009) + 0.8 * Math.sin(x * 0.007 - y * 0.006);
    const edge = 0.55 + 0.45 * Math.pow(Math.abs(x / width - 0.5) * 2, 1.3);
    return (
      edge *
      (22 * Math.pow(0.5 + 0.5 * Math.sin(phase), 6) +
        3 * Math.pow(0.5 + 0.5 * Math.sin(phase * 3 + 0.5), 24))
    );
  };
  // The height-field normals give the folds real light and shadow without a runtime canvas.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = elevation(x + 1, y) - elevation(x - 1, y);
      const dy = elevation(x, y + 1) - elevation(x, y - 1);
      const normalLength = Math.hypot(dx, dy, 1);
      const light = Math.max(0, (dx * 0.58 + dy * 0.64 + 0.5) / normalLength);
      const rawGrain = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
      const grain = (rawGrain - Math.floor(rawGrain) - 0.5) * 1.6;
      const value = Math.round(8 + Math.pow(light, 4) * 42 + elevation(x, y) * 0.04 + grain);
      const index = (y * width + x) * 3;
      pixels[index] = value;
      pixels[index + 1] = value + 1;
      pixels[index + 2] = value + 2;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } });
}

for (const [name, source] of [
  ['neon-dark', sharp(neon()).resize(width, height)],
  ['obsidian-dark', obsidian()],
  ['avant-light', sharp(avant(false)).resize(width, height)],
  ['avant-dark', sharp(avant(true)).resize(width, height)],
]) {
  const output = `${destination}comments-${name}.webp`;
  const info = await source.webp({ quality: 89 }).toFile(output);
  console.log(`${name}: ${info.width}x${info.height}, ${info.size} bytes`);
}
