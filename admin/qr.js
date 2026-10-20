// A QR encoder for exactly what a Cloche label needs: byte mode, version 4 (33 x 33), error
// correction level H. It reproduces the output of segno (the Python library that
// docs/brand/labels/make-labels.py uses), module for module, including how segno picks the mask,
// so a sticker made on this page is the same code as one made by the script and passes the same
// damage tests (docs/brand/labels/verify-admin-sticker.py checks this for hundreds of codes).
// Written here rather than pulled in so the admin page has no third-party code on it.

const VERSION = 4;
const SIZE = 33;
const DATA_CODEWORDS = 36; // 4 blocks of 9
const BLOCKS = 4;
const EC_PER_BLOCK = 16;
const FORMAT_H = 0b10; // error correction level H

// ---- Reed-Solomon over GF(256), polynomial 0x11d
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function generator(degree) {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

function remainder(data, degree) {
  const g = generator(degree);
  const rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= mul(g[i + 1], factor);
  }
  return rem;
}

// ---- data codewords: mode 0100, 8-bit length, bytes, terminator, padding
function dataCodewords(bytes) {
  if (bytes.length > 34) throw new Error('Too long for a version 4 code');
  const bits = [];
  const push = (value, count) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  const capacity = DATA_CODEWORDS * 8;
  push(0, Math.min(4, capacity - bits.length));
  // segno adds a whole zero byte when the terminator already ends on a byte boundary (always, for
  // our 29-character links). It is valid padding, and matching it keeps the codes identical.
  push(0, 8 - (bits.length % 8));
  const words = [];
  for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0; words.length < DATA_CODEWORDS; pad++) words.push(pad % 2 ? 0x11 : 0xec);
  return words;
}

function finalMessage(words) {
  const per = DATA_CODEWORDS / BLOCKS;
  const data = [];
  const ec = [];
  for (let b = 0; b < BLOCKS; b++) {
    const block = words.slice(b * per, (b + 1) * per);
    data.push(block);
    ec.push(remainder(block, EC_PER_BLOCK));
  }
  const out = [];
  for (let i = 0; i < per; i++) for (const block of data) out.push(block[i]);
  for (let i = 0; i < EC_PER_BLOCK; i++) for (const block of ec) out.push(block[i]);
  return out;
}

// ---- function patterns
function blank() {
  return Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
}

/** Returns { modules, isFunction }: the dark function modules, and which cells are not data. */
function functionPatterns() {
  const modules = blank();
  const isFunction = blank();
  const mark = (r, c, dark) => {
    if (r < 0 || c < 0 || r >= SIZE || c >= SIZE) return;
    modules[r][c] = dark ? 1 : 0;
    isFunction[r][c] = 1;
  };
  // Finder patterns with their separators.
  for (const [r0, c0] of [[0, 0], [0, SIZE - 7], [SIZE - 7, 0]]) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        mark(r0 + dr, c0 + dc, dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 && ring !== 2);
      }
    }
  }
  // Timing patterns.
  for (let i = 8; i < SIZE - 8; i++) {
    mark(6, i, i % 2 === 0);
    mark(i, 6, i % 2 === 0);
  }
  // The one alignment pattern of version 4, centred on (26, 26).
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      mark(26 + dr, 26 + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
  }
  return { modules, isFunction };
}

/** Cells reserved for the format information and the dark module. */
function reserveFormat(isFunction) {
  for (let i = 0; i < 9; i++) {
    isFunction[8][i] = 1;
    isFunction[i][8] = 1;
  }
  for (let i = 0; i < 8; i++) {
    isFunction[8][SIZE - 1 - i] = 1;
    isFunction[SIZE - 1 - i][8] = 1;
  }
}

function placeCodewords(modules, isFunction, words) {
  const bits = [];
  for (const w of words) for (let i = 7; i >= 0; i--) bits.push((w >> i) & 1);
  let k = 0;
  let upward = true;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the timing column is skipped
    for (let step = 0; step < SIZE; step++) {
      const r = upward ? SIZE - 1 - step : step;
      for (const c of [right, right - 1]) {
        if (!isFunction[r][c]) modules[r][c] = k < bits.length ? bits[k++] : 0;
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

function applyMask(modules, isFunction, mask) {
  return modules.map((row, i) =>
    row.map((v, j) => (isFunction[i][j] ? v : v ^ (MASKS[mask](i, j) ? 1 : 0)))
  );
}

// ---- mask choice: segno's scoring, which is the ISO penalty rules with a simplified rule 3.
const N3 = [1, 0, 1, 1, 1, 0, 1];
function n3Occurrences(seq) {
  let count = 0;
  const find = (from) => {
    for (let i = from; i <= seq.length - 7; i++) if (N3.every((v, k) => seq[i + k] === v)) return i;
    return -1;
  };
  let idx = find(0);
  while (idx !== -1) {
    let offset = idx + 7;
    const before = seq.slice(Math.max(idx - 4, 0), Math.min(idx, SIZE));
    const after = seq.slice(Math.max(offset, 0), Math.min(offset + 4, SIZE));
    if (idx === 0 || idx === SIZE - 7 || !before.some(Boolean) || !after.some(Boolean)) count += 40;
    else offset = idx + 4;
    idx = find(offset);
  }
  return count;
}

function score(m) {
  let n1 = 0;
  let n2 = 0;
  let n3 = 0;
  let dark = 0;
  for (let i = 0; i < SIZE; i++) {
    let rowPrev = -1;
    let colPrev = -1;
    let rowRun = 0;
    let colRun = 0;
    const column = [];
    for (let j = 0; j < SIZE; j++) {
      const r = m[i][j];
      const c = m[j][i];
      column.push(c);
      dark += r;
      if (r === rowPrev) rowRun++;
      else {
        if (rowRun >= 5) n1 += rowRun - 2;
        rowRun = 1;
      }
      if (c === colPrev) colRun++;
      else {
        if (colRun >= 5) n1 += colRun - 2;
        colRun = 1;
      }
      if (i > 0 && j > 0 && r === rowPrev && r === m[i - 1][j] && r === m[i - 1][j - 1]) n2 += 3;
      rowPrev = r;
      colPrev = c;
    }
    n3 += n3Occurrences(m[i]) + n3Occurrences(column);
    if (rowRun >= 5) n1 += rowRun - 2;
    if (colRun >= 5) n1 += colRun - 2;
  }
  const n4 = 10 * Math.floor(Math.abs((dark / (SIZE * SIZE)) * 100 - 50) / 5);
  return n1 + n2 + n3 + n4;
}

// ---- format information (BCH 15,5) and its placement
function formatBits(mask) {
  const data = (FORMAT_H << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  return ((data << 10) | rem) ^ 0x5412;
}

function addFormat(m, mask) {
  const info = formatBits(mask);
  let voffset = 0;
  let hoffset = 0;
  for (let i = 0; i < 8; i++) {
    const vbit = (info >> i) & 1;
    const hbit = (info >> (14 - i)) & 1;
    if (i === 6) {
      voffset += 1; // skip the timing pattern
      hoffset = 1;
    }
    m[i + voffset][8] = vbit;
    m[8][i + hoffset] = hbit;
    m[8][SIZE - 1 - i] = vbit;
    m[SIZE - 1 - i][8] = hbit;
  }
  m[SIZE - 8][8] = 1; // the dark module
}

/** The code's modules as rows of 0/1 (no quiet zone) for the text, or throws if it won't fit. */
export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)];
  const { modules, isFunction } = functionPatterns();
  reserveFormat(isFunction);
  placeCodewords(modules, isFunction, finalMessage(dataCodewords(bytes)));
  // The mask is chosen before the format information goes in, as segno does.
  let best = null;
  let bestScore = Infinity;
  let bestMask = 0;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = applyMask(modules, isFunction, mask);
    const s = score(candidate);
    if (s < bestScore) {
      bestScore = s;
      best = candidate;
      bestMask = mask;
    }
  }
  addFormat(best, bestMask);
  return best;
}

export { SIZE, VERSION };
