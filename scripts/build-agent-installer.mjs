// ─────────────────────────────────────────────────────────────────────────────
//  Build the two one-file desktop-agent installers.
// ─────────────────────────────────────────────────────────────────────────────
//
//  Output: dist/agent/focus-agent-linux.sh   (also served for macOS)
//          dist/agent/focus-agent-windows.ps1
//
//  Each is `desktop/install/template.{sh,ps1}` with `#__PAYLOAD__` replaced by one
//  `unpack`/`Unpack` call per file, carrying that file gzipped and base64'd. The
//  result installs the agent with no network, no git, no npm and no TypeScript — the
//  user needs Node.js, which the agent runs on anyway, and one command.
//
//  WHY EMBED RATHER THAN DOWNLOAD. An installer that clones the repository or pulls a
//  release tarball needs the repository to be public, to stay public, and to keep a
//  URL alive; this one is a file, and a file that worked when it was downloaded works
//  a year later on a laptop with no network. It is also the only shape that lets the
//  EXTENSION hand it over: the popup downloads it out of its own bundle
//  (chrome-extension://…/agent/…), so nothing about the flow depends on GitHub, on
//  the repository's visibility, or on this project having a release process.
//
//  WHY IT COMPILES THE AGENT HERE. `desktop/dist/` is gitignored — the agent is
//  TypeScript, and `tsc` is the one thing a user should not have to install to run a
//  350-line helper. The root already depends on `typescript` AND `@types/node`, so
//  this compiles with the root's toolchain and needs no `npm install` inside
//  `desktop/`. If that ever stops being true this script fails loudly rather than
//  shipping an installer whose payload has no dist/.
//
//  The agent's SOURCE and the LICENCE travel too. Focus is GPL-3.0: conveying the
//  compiled program means conveying the licence with it and being able to answer for
//  the source, and `src/*.ts` beside `dist/*.js` is the cheapest possible way to be
//  straightforwardly correct rather than technically arguable.
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'desktop');
const outDir = path.join(root, 'dist', 'agent');

/** Files that go into the installed folder, as `destination ← source`.
 *
 *  Order is the order they are written, which matters only in that `dist/` must be
 *  complete before `launch.sh` could ever run — nothing here runs it. Everything is
 *  small; the whole payload is well under 200 kB before compression. */
function payloadList(compiled) {
  return [
    // Compiled agent — the point of the exercise. No tsc on the user's machine.
    ['dist/index.js', path.join(compiled, 'index.js')],
    ['dist/foreground.js', path.join(compiled, 'foreground.js')],
    // Source beside it. GPL-3.0, and it also makes the installed copy hackable.
    ['src/index.ts', path.join(desktop, 'src/index.ts')],
    ['src/foreground.ts', path.join(desktop, 'src/foreground.ts')],
    ['package.json', path.join(desktop, 'package.json')],
    ['tsconfig.json', path.join(desktop, 'tsconfig.json')],
    ['LICENSE', path.join(root, 'LICENSE')],
    // What makes it clickable and stoppable.
    ['launch.sh', path.join(desktop, 'launch.sh')],
    ['install-icon.sh', path.join(desktop, 'install-icon.sh')],
    ['install-icon.ps1', path.join(desktop, 'install-icon.ps1')],
    ['icon.svg', path.join(desktop, 'icon.svg')],
    ['README.md', path.join(desktop, 'README.md')],
    // The GNOME Shell bridge: the only way to read the foreground program on Wayland,
    // and the only thing that can pin or fade the companion window there.
    ['gnome-extension/extension.js', path.join(desktop, 'gnome-extension/extension.js')],
    ['gnome-extension/prefs.js', path.join(desktop, 'gnome-extension/prefs.js')],
    ['gnome-extension/metadata.json', path.join(desktop, 'gnome-extension/metadata.json')],
    ['gnome-extension/install.sh', path.join(desktop, 'gnome-extension/install.sh')],
    ['gnome-extension/schemas/org.gnome.shell.extensions.focus-companion.gschema.xml',
      path.join(desktop, 'gnome-extension/schemas/org.gnome.shell.extensions.focus-companion.gschema.xml')],
  ];
}

// ── Compile the agent with the ROOT toolchain ────────────────────────────────
// `--sourceMap false` overrides the tsconfig: a .js.map with no .ts beside it in
// dist/ is a broken pointer, and doubling the payload to ship one is not worth it.
const compiled = mkdtempSync(path.join(tmpdir(), 'focus-agent-'));
try {
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(process.execPath, [
    tsc, '-p', path.join(desktop, 'tsconfig.json'),
    '--outDir', compiled, '--sourceMap', 'false',
  ], { stdio: 'inherit' });

  // ── Wrap each file as one unpack call ──────────────────────────────────────
  // Level 9 because this runs once per build and the file is downloaded over and
  // over. base64 of gzip, not of the raw bytes: the payload is mostly text and
  // compresses ~3×, which is the difference between a 60 kB download and a 200 kB one.
  const blobs = payloadList(compiled).map(([dest, src]) => ({
    dest,
    b64: gzipSync(readFileSync(src), { level: 9 }).toString('base64'),
  }));

  const emit = (template, out, line) => {
    const src = readFileSync(path.join(desktop, 'install', template), 'utf8');
    if (!src.includes('#__PAYLOAD__')) {
      throw new Error(`${template} has no #__PAYLOAD__ marker`);
    }
    const body = blobs.map(line).join('\n');
    mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, out);
    writeFileSync(file, src.replace('#__PAYLOAD__', body));
    // Only meaningful on the copy in dist/ — a browser download drops the mode bit,
    // which is why every instruction says `sh file.sh` rather than `./file.sh`.
    if (out.endsWith('.sh')) chmodSync(file, 0o755);
    return file;
  };

  // Single quotes on both sides: base64's alphabet contains neither `'` nor `$`, so
  // no shell or PowerShell interpolation can reach inside a blob.
  const files = [
    emit('template.sh', 'focus-agent-linux.sh', (b) => `unpack '${b.dest}' '${b.b64}'`),
    emit('template.ps1', 'focus-agent-windows.ps1', (b) => `Unpack '${b.dest}' '${b.b64}'`),
  ];

  for (const f of files) {
    const kb = (readFileSync(f).length / 1024).toFixed(0);
    console.log(`agent installer  ${path.relative(root, f)}  ${kb} kB`);
  }
} finally {
  rmSync(compiled, { recursive: true, force: true });
}
