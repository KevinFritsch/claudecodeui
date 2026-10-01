// Regenerates the Kvn AI robot icons in public/ (favicon, logo, PWA icons): node scripts/generate-kvn-ai-icons.mjs
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/home/kvn/claudecodeui/package.json');
const sharp = require('sharp');

// The Kvn AI robot on a 512x512 canvas. `rounded` = tile with corners (favicon,
// in-app logo); full-bleed square for PWA icons, which the OS masks itself.
const robot = (rounded) => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4f8cff"/>
      <stop offset="1" stop-color="#1d4ed8"/>
    </linearGradient>
    <linearGradient id="head" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#dbe7ff"/>
    </linearGradient>
    <radialGradient id="eye" cx="0.5" cy="0.4" r="0.6">
      <stop offset="0" stop-color="#e0fbff"/>
      <stop offset="0.55" stop-color="#5eeaff"/>
      <stop offset="1" stop-color="#22b8e6"/>
    </radialGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/>
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="7" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="14" stdDeviation="14" flood-color="#0b1f5c" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect width="512" height="512" rx="${rounded ? 116 : 0}" fill="url(#bg)"/>
  <rect width="512" height="512" rx="${rounded ? 116 : 0}" fill="url(#shine)"/>
  <g filter="url(#shadow)">
    <line x1="256" y1="176" x2="256" y2="124" stroke="#ffffff" stroke-width="16" stroke-linecap="round"/>
    <circle cx="256" cy="112" r="22" fill="url(#eye)" filter="url(#glow)"/>
    <rect x="106" y="238" width="34" height="84" rx="17" fill="#c7d8ff"/>
    <rect x="372" y="238" width="34" height="84" rx="17" fill="#c7d8ff"/>
    <rect x="128" y="172" width="256" height="220" rx="64" fill="url(#head)"/>
    <rect x="162" y="214" width="188" height="112" rx="46" fill="#0f2257"/>
    <circle cx="214" cy="270" r="23" fill="url(#eye)" filter="url(#glow)"/>
    <circle cx="298" cy="270" r="23" fill="url(#eye)" filter="url(#glow)"/>
    <rect x="226" y="346" width="60" height="12" rx="6" fill="#9db8f5"/>
  </g>
</svg>`;

const out = '/home/kvn/claudecodeui/public';
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
