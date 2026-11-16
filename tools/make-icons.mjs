#!/usr/bin/env node
/*
 * Rasterises icons/icon.svg and icons/icon-small.svg into the PNGs the manifest points at.
 * Needs no npm packages — it drives a Chromium-based browser that is already installed.
 *
 *   node tools/make-icons.mjs
 *   BROWSER="C:\path\to\chrome.exe" node tools/make-icons.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const icons = join(root, 'icons');

// The detailed artwork holds up from 48px; the toolbar sizes use the bolder cut.
const targets = [
  { size: 16, source: 'icon-small.svg' },
  { size: 32, source: 'icon-small.svg' },
  { size: 48, source: 'icon.svg' },
  { size: 128, source: 'icon.svg' },
];

function findBrowser() {
  const candidates = [process.env.BROWSER];
  const local = process.env.LOCALAPPDATA;
  if (local && existsSync(join(local, 'ms-playwright'))) {
    for (const dir of readdirSync(join(local, 'ms-playwright'))) {
      if (dir.startsWith('chromium_headless_shell')) {
        candidates.push(join(local, 'ms-playwright', dir, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
      }
    }
  }
  candidates.push(
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  );
  return candidates.find((path) => path && existsSync(path));
}

const browser = findBrowser();
if (!browser) {
  console.error('No Chromium-based browser found. Set BROWSER to the path of chrome / msedge.');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'ytwl-icons-'));
try {
  for (const { size, source } of targets) {
    const page = join(work, `icon${size}.html`);
    const svg = pathToFileURL(join(icons, source)).href;
    writeFileSync(
      page,
      `<!doctype html><style>html,body{margin:0;background:transparent;overflow:hidden}img{display:block}</style>` +
        `<img src="${svg}" width="${size}" height="${size}">`
    );
    const out = join(icons, `icon${size}.png`);
    execFileSync(
      browser,
      [
        '--headless',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--default-background-color=00000000',
        `--user-data-dir=${join(work, 'profile')}`,
        `--window-size=${size},${size}`,
        `--screenshot=${out}`,
        pathToFileURL(page).href,
      ],
      { stdio: 'ignore' }
    );
    console.log(`icons/icon${size}.png`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
