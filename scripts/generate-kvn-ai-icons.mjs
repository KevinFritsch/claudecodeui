// Regenerates the Kvn AI robot icons in public/ (favicon, logo, PWA icons): node scripts/generate-kvn-ai-icons.mjs
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(`${root}/package.json`);
const sharp = require('sharp');

// The Kvn AI mark on a 512x512 canvas: an abstract robot, one gradient "head"
// with two pill eyes cut out and a floating antenna dot, on a light iris tile with
// a soft white/mint glow. Bold shapes only, so it still reads at 16px.
// `rounded` = tile with corners (favicon, in-app logo); full-bleed square for
// PWA icons, which the OS masks itself.
const robot = (rounded) => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#b3b0ff"/>
      <stop offset="1" stop-color="#6f69ec"/>
    </linearGradient>
    <radialGradient id="glowIris" cx="0.22" cy="0.12" r="0.75">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowMint" cx="0.9" cy="0.95" r="0.6">
      <stop offset="0" stop-color="#5eead4" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#2dd4bf" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="mark" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#e9e8ff"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <mask id="eyes">
      <rect width="512" height="512" fill="#fff"/>
      <rect x="194" y="236" width="38" height="84" rx="19" fill="#000"/>
      <rect x="280" y="236" width="38" height="84" rx="19" fill="#000"/>
    </mask>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#2a2580" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect width="512" height="512" rx="${rounded ? 116 : 0}" fill="url(#tile)"/>
  <rect width="512" height="512" rx="${rounded ? 116 : 0}" fill="url(#glowIris)"/>
  <rect width="512" height="512" rx="${rounded ? 116 : 0}" fill="url(#glowMint)"/>
  ${rounded ? '<rect x="1.5" y="1.5" width="509" height="509" rx="114.5" fill="none" stroke="#ffffff" stroke-opacity="0.18" stroke-width="3"/>' : ''}
  <g filter="url(#soft)">
    <circle cx="256" cy="116" r="28" fill="url(#mark)"/>
    <g mask="url(#eyes)">
      <rect x="112" y="172" width="288" height="216" rx="96" fill="url(#mark)"/>
      <rect x="112" y="172" width="288" height="216" rx="96" fill="url(#sheen)"/>
    </g>
  </g>
</svg>`;
const out = `${root}/public`;
const roundedSvg = robot(true);
const squareSvg = robot(false);
writeFileSync(`${out}/favicon.svg`, roundedSvg);
writeFileSync(`${out}/logo.svg`, roundedSvg);
writeFileSync(`${out}/icons/icon-template.svg`, squareSvg);

const render = (svg, size, file) => sharp(Buffer.from(svg), { density: 384 }).resize(size, size).png().toFile(file);
for (const size of [72, 96, 128, 144, 152, 192, 384, 512]) {
  await render(squareSvg, size, `${out}/icons/icon-${size}x${size}.png`);
  writeFileSync(`${out}/icons/icon-${size}x${size}.svg`, squareSvg.replace('width="512" height="512"', `width="${size}" height="${size}"`));
}
for (const size of [32, 64, 128, 256, 512]) await render(roundedSvg, size, `${out}/logo-${size}.png`);
await render(roundedSvg, 64, `${out}/favicon.png`);
console.log('icons written');
