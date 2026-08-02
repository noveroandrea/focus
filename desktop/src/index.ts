// ─────────────────────────────────────────────────────────────────────────────
//  THE FOCUS AGENT
// ─────────────────────────────────────────────────────────────────────────────
//  Two operations, and deliberately nothing else:
//
//    1. watch which program is in the foreground   (./foreground.ts)
//    2. answer the browser extension when it asks  (this file)
//
//  Plus one courtesy on Windows only, because nothing else there can do it: the
//  foreground helper keeps the extension's companion window above other windows.
//  That is window management, not sensing, and it is confined to the one platform
//  with no alternative — on GNOME the Shell bridge does it from inside the
//  compositor, and on macOS no process may do it to another's window at all.
//
//  No account, no session, no sync, no scoring, no whitelist, no window, no tray,
//  no settings file. The extension is the central node: it owns the program list,
//  the heartbeats, the score and the sprite, and it decides what a foreground
//  program means. This process is a sensor with an HTTP socket.
//
//  ── WHY HTTP ON LOOPBACK RATHER THAN NATIVE MESSAGING ──────────────────────
//  chrome.runtime.connectNative is the canonical route, but a native messaging
//  host manifest must name the exact extension ID it may talk to — and this
//  extension's ID is not pinned, so it changes whenever the unpacked folder moves.
//  A loopback port needs no manifest, no ID, and no installer writing into the
//  browser's own configuration directory. The extension already polls chrome.idle
//  twice a second; this rides along with that poll.
//
//  ── WHY A WEB PAGE CANNOT READ IT ──────────────────────────────────────────
//  Three things, none of which relies on the others:
//
//    • the socket is bound to 127.0.0.1, so nothing off this machine can connect;
//    • NO CORS headers are sent, so a page's fetch is blocked from reading the
//      response by the browser itself — while the extension, which holds an
//      explicit host permission for this port, is exempt;
//    • requests carrying a web Origin are refused outright.
//
//  So "which programs does this person use" is not readable by any site visited.
// ─────────────────────────────────────────────────────────────────────────────

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { foreground, note, start, stop } from './foreground';

/** Must match AGENT_URL in src/extension/agent.ts and the host permission in
 *  manifest.json — three copies of one number, so changing it means changing all
 *  three. Chosen from the unassigned dynamic range to make a clash unlikely. */
const AGENT_PORT = Number(process.env.FOCUS_AGENT_PORT ?? 47317);

function handle(req: IncomingMessage, res: ServerResponse) {
  // A browser sends Origin on any cross-origin request; extensions do not send a
  // web origin. Belt and braces alongside the absent CORS headers.
  const origin = req.headers.origin;
  if (origin && !origin.startsWith('chrome-extension://') && !origin.startsWith('moz-extension://')) {
    res.writeHead(403).end();
    return;
  }
  if (req.method !== 'GET') {
    res.writeHead(405).end();
    return;
  }

  const program = foreground();
  res.writeHead(200, {
    'Content-Type': 'application/json',
    // The reading changes constantly and is never worth reusing.
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({
    program,
    note: note(),
    ts: Date.now(),
    // So `launch.sh stop` can stop exactly the process holding this port, however it
    // was started. Matching a command line is guesswork — `npm start` and a desktop
    // icon produce different ones for the same agent — and a pid file would mean
    // writing to disk for something the socket already knows.
    pid: process.pid,
  }));
}

const server = createServer(handle);

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Focus agent: port ${AGENT_PORT} is already in use — another copy is probably `
      + 'already running. Only one is needed.',
    );
  } else {
    console.error('Focus agent: could not listen:', String(err).slice(0, 160));
  }
  process.exit(1);
});

// Loopback only. Never 0.0.0.0, which would put the foreground program of this
// machine on the local network.
server.listen(AGENT_PORT, '127.0.0.1', () => {
  start();
  console.log(`Focus agent: listening on http://127.0.0.1:${AGENT_PORT}`);
  const limitation = note();
  if (limitation) console.warn('Focus agent:', limitation);
  else console.log('Focus agent: watching the foreground program. Ctrl+C to stop.');
});

function shutdown() {
  stop();
  server.close(() => process.exit(0));
  // Do not wait forever on a lingering keep-alive connection.
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
