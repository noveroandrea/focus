// ─────────────────────────────────────────────────────────────────────────────
//  Package dist/ into the zip that gets uploaded to the Chrome Web Store.
// ─────────────────────────────────────────────────────────────────────────────
//
//  Run after a build:  npm run package   (which builds first)
//  Output:             focus-<version>.zip in the repository root
//
//  Two things it does that zipping dist/ by hand does not:
//
//  1. IT LEAVES OUT THE DEV DEMO. `index.html` and its bundle are the
//     SpriteSimulation harness used by `npm run dev` — ~195 kB of React that no
//     published extension ever loads. Shipping it means shipping unreviewed dead
//     code past a human reviewer whose job is to ask what every file is for.
//  2. IT REFUSES TO BUILD A BROKEN PACKAGE. The manifest's icons and every HTML
//     entry are checked to exist before anything is zipped, because the failure mode
//     is otherwise a rejected submission days later rather than an error now.
//
//  The version in the filename comes from manifest.json, which is the version the
//  store actually reads — package.json's copy is not the one that matters.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

if (!existsSync(dist)) {
  console.error('No dist/ — run `npm run build` first.');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(path.join(dist, 'manifest.json'), 'utf8'));

// ── Refuse to ship something obviously incomplete ────────────────────────────
const required = [
  'manifest.json',
  'background.js',
  'heartbeat.js',
  'sprite.js',
  'popup.html',
  'pip.html',
  'dashboard.html',
  ...Object.values(manifest.icons ?? {}),
];
const missing = required.filter((f) => !existsSync(path.join(dist, f)));
if (missing.length) {
  console.error(`dist/ is missing: ${missing.join(', ')}`);
  process.exit(1);
}
if (!manifest.icons?.['128']) {
  console.error('manifest.json has no 128 px icon — the store requires one.');
  process.exit(1);
}

// The agent installers are optional in a package but their absence is always a
// mistake (a bare `vite build` empties dist/), so it is said out loud rather than
// discovered by a user pressing Download and being told the file is missing.
if (!existsSync(path.join(dist, 'agent'))) {
  console.warn('! dist/agent/ is absent — the popup\'s agent download will not work.');
  console.warn('  Run the full `npm run build`, not `vite build`.');
}

// ── What the demo owns, and only that ────────────────────────────────────────
// DERIVED, not named. The obvious version of this excluded `assets/index-*.js` on the
// reasoning that it belongs to index.html — and it does, but it is also the shared
// React chunk that popup.html and dashboard.html load, so that package installed
// cleanly and opened a blank popup. Rollup's names are hashed and its chunking
// changes with the imports, so the only safe rule is to read the four built HTML
// files and drop what nothing but the demo references.
const assetsIn = (html) => new Set(
  (readFileSync(path.join(dist, html), 'utf8').match(/assets\/[\w.-]+\.(?:js|css|woff2?)/g) ?? []),
);
const keep = new Set([
  ...assetsIn('popup.html'),
  ...assetsIn('dashboard.html'),
  ...assetsIn('pip.html'),
]);
const demoBundles = [...assetsIn('index.html')].filter((a) => !keep.has(a));

// Every asset the real entries reference must actually be in dist/ — a build that
// dropped one is the same blank popup, found here instead of by a user.
const brokenRefs = [...keep].filter((a) => !existsSync(path.join(dist, a)));
if (brokenRefs.length) {
  console.error(`popup/dashboard/pip reference missing files: ${brokenRefs.join(', ')}`);
  process.exit(1);
}

const zipName = `focus-${manifest.version}.zip`;
const zipPath = path.join(root, zipName);
rmSync(zipPath, { force: true });

// `zip` rather than a node library: it is present on every machine this is built on,
// and a store package is a plain zip with no manifest of its own to get wrong.
execFileSync('zip', [
  '-r', '-q', '-X',            // -X: no extra file attributes, so the zip is reproducible
  zipPath, '.',
  '-x', 'index.html',
  ...demoBundles.flatMap((f) => ['-x', f]),
  '-x', '*.map',               // source maps: bulk, and not what is reviewed
], { cwd: dist, stdio: 'inherit' });

// ── Verify the package, rather than trust the exclusions ─────────────────────
// Same reason as above: the cost of a wrong `-x` is a store review spent on a broken
// build, and `unzip -l` is one call.
const listed = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
  .split('\n').filter(Boolean);
const absent = [...keep, ...required].filter((f) => !listed.includes(f));
if (absent.length) {
  console.error(`\nThe zip is missing files the extension needs: ${absent.join(', ')}`);
  rmSync(zipPath, { force: true });
  process.exit(1);
}

const kb = (readFileSync(zipPath).length / 1024).toFixed(0);
console.log(`\n${zipName}  ${kb} kB  ·  ${listed.length} files, all references present`);
console.log('Upload it at https://chrome.google.com/webstore/devconsole');
console.log(`Left out: index.html${demoBundles.length ? ` + ${demoBundles.join(', ')}` : ''} (the dev demo), and source maps.`);
