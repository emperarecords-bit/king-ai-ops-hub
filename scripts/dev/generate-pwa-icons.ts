/**
 * One-shot generator for the PWA icon set (public/icons/*). A simple, bold
 * mark — gold crown on the app's dark surface — rendered from inline SVG via
 * sharp (already a dependency through Next). Kept in-repo for provenance;
 * re-run to regenerate.
 */
import { mkdirSync } from 'node:fs';
import sharp from 'sharp';

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#0b0e14"/>
  <g fill="#d4a843">
    <path d="M96 336 L74 176 L166 254 L256 128 L346 254 L438 176 L416 336 Z"/>
    <rect x="96" y="356" width="320" height="40" rx="12"/>
  </g>
  <circle cx="74" cy="160" r="18" fill="#d4a843"/>
  <circle cx="256" cy="108" r="20" fill="#d4a843"/>
  <circle cx="438" cy="160" r="18" fill="#d4a843"/>
</svg>`;

const OUT = 'public/icons';
mkdirSync(OUT, { recursive: true });

async function main() {
  const buf = Buffer.from(SVG);
  await sharp(buf).resize(512, 512).png().toFile(`${OUT}/icon-512.png`);
  await sharp(buf).resize(192, 192).png().toFile(`${OUT}/icon-192.png`);
  // Apple touch icon: no rounded corners (iOS applies its own mask), solid bg.
  const apple = SVG.replace('rx="96"', 'rx="0"');
  await sharp(Buffer.from(apple)).resize(180, 180).png().toFile(`${OUT}/apple-touch-icon.png`);
  console.log('icons written: icon-512, icon-192, apple-touch-icon');
}
void main();
