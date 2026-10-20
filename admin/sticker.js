// The Cloche pot sticker (the "glass dome" design settled on 15 Oct 2026), drawn in the browser.
// This is a port of docs/brand/labels/make-labels.py and draws the same label: 52 x 92 mm, a QR
// holding https://cloche.one/p/<code> with the sprout in a glass disc at its centre, the plant's
// common name, and the shop in a walnut band. docs/brand/labels/verify-admin-sticker.py checks
// that the two produce the same drawing, so change both together or neither.
import { qrMatrix } from './qr.js';

// Brand colours (docs/cloche-blueprint.html).
const WALNUT = '#7A5A40';
const GLASS = '#24402F';
const SPROUT = '#A3B566';
const LINEN = '#FAF7F1';
const OLIVE = '#5E6E2E';
const LIGHT_WALNUT = '#C49A78';
const ON_GLASS = '#F4EEE5';
const WINDOW_FILL = '#E6EBD3';

// Geometry, in millimetres.
export const W = 52.0;
export const H = 92.0;
const QR_MM = 30.0;
const WINDOW_MM = 38.0;
const WINDOW_H = WINDOW_MM;
const WINDOW_X = (W - WINDOW_MM) / 2;
const WINDOW_Y = 25.0;
const QR_X = WINDOW_X + (WINDOW_MM - QR_MM) / 2;
const QR_Y = WINDOW_Y + 3.0;
const KNOCKOUT_R = 4.4;
const DISC_R = 3.9;

const HOW = ['Cloche fills in the care', 'for your plant'];
const NEW_HERE = 'New here? Scan to start.';

/** What the QR holds. */
export const labelUrl = (code) => `https://cloche.one/p/${code}`;

/** Matches Python's html.escape, which the script uses. */
export function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

const f3 = (n) => n.toFixed(3);

function knockedOut(size, x, y) {
  const c = size / 2;
  return (x + 0.5 - c) ** 2 + (y + 0.5 - c) ** 2 <= KNOCKOUT_R ** 2;
}

function qrGroup(code) {
  const rows = qrMatrix(labelUrl(code));
  const n = rows.length;
  const m = QR_MM / n;
  const cx = QR_X + QR_MM / 2;
  const cy = QR_Y + QR_MM / 2;
  const path = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < n) {
      if (row[x] && !knockedOut(n, x, y)) {
        const start = x;
        while (x < n && row[x] && !knockedOut(n, x, y)) x++;
        const run = f3((x - start) * m);
        path.push(`M${f3(QR_X + start * m)} ${f3(QR_Y + y * m)}h${run}v${f3(m)}h-${run}z`);
      } else {
        x++;
      }
    }
  });
  const scale = (DISC_R * m * 1.45) / 30.0;
  const sprout =
    `<g transform="translate(${f3(cx)} ${f3(cy)}) scale(${scale.toFixed(4)}) translate(-60.6 -88.8)">` +
    `<path d="M60 102 V87.6" stroke="${SPROUT}" stroke-width="4.8" stroke-linecap="round" fill="none"/>` +
    `<path d="M60 90 C60 80.4 67.2 75.6 75.6 75.6 C75.6 84 69.6 90 60 90 Z ` +
    `M60 93.6 C60 85.2 52.8 81.6 45.6 81.6 C45.6 88.8 51.6 93.6 60 93.6 Z" fill="${SPROUT}"/>` +
    `</g>`;
  return (
    `<path d="${path.join('')}" fill="${GLASS}"/>` +
    `<circle cx="${f3(cx)}" cy="${f3(cy)}" r="${f3(KNOCKOUT_R * m)}" fill="${WINDOW_FILL}"/>` +
    `<circle cx="${f3(cx)}" cy="${f3(cy)}" r="${f3(DISC_R * m)}" fill="${GLASS}"/>` +
    sprout
  );
}

// The Cloche mark, as on dark grounds (docs/brand/logo/cloche-logo-on-dark.svg), 120 x 120.
const MARK =
  '<path d="M20 102 V66 C20 40 38 22 60 22 C82 22 100 40 100 66 V102 Z" fill="#2E4F3A"/>' +
  '<path d="M60 102 V87.6" stroke="#A3B566" stroke-width="4.8" stroke-linecap="round" fill="none"/>' +
  '<path d="M60 90 C60 80.4 67.2 75.6 75.6 75.6 C75.6 84 69.6 90 60 90 Z ' +
  'M60 93.6 C60 85.2 52.8 81.6 45.6 81.6 C45.6 88.8 51.6 93.6 60 93.6 Z" fill="#A3B566"/>' +
  '<g fill="none" stroke="#C49A78" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M20 66 H100 M40 66 C40 44 48 29 60 22 M80 66 C80 44 72 29 60 22 M60 22 V66" stroke-width="3.5"/>' +
  '<path d="M20 102 V66 C20 40 38 22 60 22 C82 22 100 40 100 66 V102 Z" stroke-width="6"/>' +
  '<path d="M60 22 V13" stroke-width="4"/><path d="M10 102 H110" stroke-width="6"/></g>' +
  '<circle cx="60" cy="10.5" r="4.5" fill="#C49A78"/>';

/**
 * One label as SVG text.
 * @param {{code: string, common: string, shop: string, standalone?: boolean}} label
 *   `shop` is the name printed in the band. `standalone` adds the XML namespace and the die-cut
 *   contour, for a print shop.
 */
export function labelSvg({ code, common, shop, standalone = false }) {
  const attrs = standalone
    ? `xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}"`
    : `viewBox="0 0 ${W} ${H}" width="${W}mm" height="${H}mm"`;
  const face = 'font-family="Sora, Avenir Next, Helvetica, Arial, sans-serif"';
  const body = 'font-family="Figtree, Helvetica Neue, Helvetica, Arial, sans-serif"';
  const mono = 'font-family="JetBrains Mono, Menlo, Courier New, monospace"';
  const cx = W / 2;
  const bottom = H - 2.0;
  const d0 = (W - 44.0) / 2;
  const d1 = W - (W - 44.0) / 2;
  const py1 = bottom - 0.75;
  const py2 = bottom + 0.75;
  const cut = standalone
    ? `\n  <path id="CutContour" fill="none" stroke="#FF00FF" stroke-width="0.1" ` +
      `d="M0.5 ${py2} H${W - 0.5} V${py1} H${d1 + 0.75} V26 ` +
      `C${d1 + 0.75} 13.6 ${cx + 13.2} 6.25 ${cx + 0.7} 6.25 V4.87 A2 2 0 1 0 ${cx - 0.7} 4.87 V6.25 ` +
      `C${cx - 13.2} 6.25 ${d0 - 0.75} 13.6 ${d0 - 0.75} 26 V${py1} H0.5 Z"/>`
    : '';
  return `<svg ${attrs} role="img" aria-label="Cloche label for ${esc(common)} from ${esc(shop)}. Scan to add it.">
  <path d="M${cx} 7 V5" stroke="${WALNUT}" stroke-width="1.4" stroke-linecap="round"/>
  <circle cx="${cx}" cy="3" r="2" fill="${WALNUT}"/>
  <path d="M${d0} ${bottom} V26 C${d0} 14 ${d0 + 9} 7 ${cx} 7 C${d1 - 9} 7 ${d1} 14 ${d1} 26 V${bottom} Z" fill="${GLASS}"/>
  <path d="M${d0} ${bottom} V26 C${d0} 14 ${d0 + 9} 7 ${cx} 7 C${d1 - 9} 7 ${d1} 14 ${d1} 26 V${bottom}" fill="none" stroke="${WALNUT}" stroke-width="1.5" stroke-linejoin="round"/>
  <rect x="0.5" y="${bottom - 0.75}" width="${W - 1.0}" height="1.5" rx="0.75" fill="${WALNUT}"/>
  <g transform="translate(${cx - 3.5} 9.4) scale(0.07) translate(-10 -6)">${MARK}</g>
  <text x="${cx}" y="21.7" text-anchor="middle" font-size="4.6" font-weight="700" letter-spacing="-0.1" fill="${ON_GLASS}" ${face}>Cloche</text>
  <rect x="${WINDOW_X}" y="${WINDOW_Y}" width="${WINDOW_MM}" height="${WINDOW_H}" rx="2.2" fill="${WINDOW_FILL}"/>
  <text x="${cx}" y="${QR_Y + QR_MM + 2.7 + 1.3}" text-anchor="middle" font-size="1.8" font-weight="500" letter-spacing="0.35" fill="${OLIVE}" ${mono}>${esc(code)}</text>
  ${qrGroup(code)}
  <text x="${cx}" y="67.9" text-anchor="middle" font-size="3.0" font-weight="700" fill="${ON_GLASS}" ${face}>${esc(HOW[0])}</text>
  <text x="${cx}" y="71.4" text-anchor="middle" font-size="3.0" font-weight="700" fill="${ON_GLASS}" ${face}>${esc(HOW[1])}</text>
  <text x="${cx}" y="75.4" text-anchor="middle" font-size="2.8" font-style="italic" fill="${LIGHT_WALNUT}" ${body}>${esc(NEW_HERE)}</text>
  <path d="M10 78.2 H${W - 10}" stroke="${WALNUT}" stroke-width="0.3"/>
  <text x="${cx}" y="${bottom - 8.0}" text-anchor="middle" font-size="3.2" font-weight="700" fill="${ON_GLASS}" ${face}>${esc(common)}</text>
  <rect x="${d0}" y="${bottom - 5.6}" width="${d1 - d0}" height="5.6" fill="${WALNUT}"/>
  <text x="${cx}" y="${bottom - 1.7}" text-anchor="middle" font-size="3.1" font-weight="600" fill="${LINEN}" ${face}>${esc(shop)}</text>${cut}
</svg>`;
}
