/* ─────────────────────────────────────────────────────────────────────────────
 *  Focus companion bridge — the GNOME/Wayland answer to "what has focus?"
 * ─────────────────────────────────────────────────────────────────────────────
 *  A Wayland client cannot see other applications' windows. That is a security
 *  property of the protocol, not a gap, so the only way to learn the focused
 *  application is to ask something already inside the compositor. On GNOME that
 *  means a Shell extension, because `org.gnome.Shell.Eval` has been locked down
 *  since GNOME 41 and there is no other general hook.
 *
 *  Needed ONLY on Wayland. An X11 session reads the same information with xprop
 *  and nothing has to be installed.
 *
 *  It exports one D-Bus object with one method and one signal, emitting exactly
 *  what the X11 helper prints so the agent parses both identically and a program
 *  whitelist written under Xorg keeps working after logging into Wayland:
 *
 *      <comm>|<application name>|<idle milliseconds>
 *
 *  ── WHAT IT DOES NOT SEND ───────────────────────────────────────────────────
 *  Never a window title. Titles leak document names, message contents and page
 *  titles; `app.get_name()` is the application's own name ("Text Editor"), which
 *  is all a whitelist ever needed. Nothing here calls get_title().
 *
 *  ── THE IDLE FIGURE ─────────────────────────────────────────────────────────
 *  Sent because it is free here and Mutter's is the only correct source on
 *  Wayland, but the agent currently ignores it: the extension already gets idle
 *  from chrome.idle, and one source per fact is the point. Kept in the payload so
 *  the format does not have to change if that ever stops being true.
 *
 *  ── WHY A TIMER AS WELL AS THE FOCUS SIGNAL ─────────────────────────────────
 *  The consumer treats a reading older than a few seconds as stale, so silence
 *  has to be distinguishable from a dead compositor. The expensive part —
 *  resolving a window to a process name via /proc — is cached and recomputed only
 *  when focus actually changes, so the timer itself does one cheap read.
 *
 *  ── AND ONE SECOND JOB: PINNING THE COMPANION WINDOW ────────────────────────
 *  A Wayland client cannot raise its own window above others — the compositor
 *  decides — which is why the floating companion otherwise has to be pinned by
 *  hand with a window-manager shortcut. But this code IS inside the compositor,
 *  where make_above() is one call. So it keeps the companion window on top
 *  automatically, and reads no title for anything else. This is the ONLY place in
 *  the project that touches a window title, and it compares it against one fixed
 *  string rather than reporting it anywhere.
 * ───────────────────────────────────────────────────────────────────────────── */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const IFACE = `
<node>
  <interface name="dev.focus.Companion">
    <method name="GetFocused">
      <arg type="s" direction="out" name="value"/>
    </method>
    <signal name="Focused">
      <arg type="s" name="value"/>
    </signal>
  </interface>
</node>`;

const OBJECT_PATH = '/dev/focus/Companion';

/** How often the reading is published. */
const EMIT_INTERVAL_MS = 500;

/** The floating companion's window title — pip.html's <title>. Change one and the
 *  other stops being recognised. */
const COMPANION_TITLE = 'Focus companion';

/** A window bigger than this is not pinned, however it is titled. Two reasons, and
 *  either alone would justify it: a page whose <title> happens to be "Focus
 *  companion" must not drag a whole browser window above everything, and an
 *  always-on-top window large enough to cover what you are working on is precisely
 *  the failure that got an earlier full-screen overlay deleted. The companion opens
 *  at 300×210 and is meant for a screen corner. Checked when the window appears. */
const MAX_PIN_W = 900;
const MAX_PIN_H = 700;

/** Gap from the work area's corner, in logical pixels. */
const PLACE_MARGIN = 16;

export default class FocusCompanionExtension extends Extension {
    enable() {
        this._current = '';
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._dbus.export(Gio.DBus.session, OBJECT_PATH);

        this._refresh();
        this._focusId = global.display.connect('notify::focus-window', () => this._refresh());
        this._timer = GLib.timeout_add(GLib.PRIORITY_LOW, EMIT_INTERVAL_MS, () => {
            this._emit();
            return GLib.SOURCE_CONTINUE;
        });

        // Pinning and placing: new windows from here on, plus any that already exist
        // (the companion may well have been open before this extension was enabled).
        this._titleIds = new Map();
        // Which monitor each companion was given, so the next one goes somewhere else.
        // Keyed by window, cleaned on unmanaged — a closed companion frees its screen.
        this._placed = new Map();
        this._createdId = global.display.connect('window-created', (_d, win) => this._watch(win));
        for (const actor of global.get_window_actors())
            this._watch(actor.meta_window);
    }

    disable() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        if (this._focusId) {
            global.display.disconnect(this._focusId);
            this._focusId = null;
        }
        if (this._createdId) {
            global.display.disconnect(this._createdId);
            this._createdId = null;
        }
        if (this._titleIds) {
            for (const [win, id] of this._titleIds) {
                try { win.disconnect(id); } catch { /* window already gone */ }
            }
            this._titleIds.clear();
            this._titleIds = null;
        }
        if (this._placed) {
            this._placed.clear();
            this._placed = null;
        }
        if (this._dbus) {
            this._dbus.unexport();
            this._dbus = null;
        }
        this._current = '';
    }

    /** D-Bus method: the current reading, for a consumer that has just started and
     *  does not want to wait for the next signal. */
    GetFocused() {
        return this._payload();
    }

    // ── Pinning the companion ────────────────────────────────────────────────

    /** Start watching one window. A browser window is mapped before its title is
     *  set, so the check has to run again on notify::title rather than only once at
     *  creation — otherwise the companion is examined while still called
     *  "about:blank" and never looked at again. The handler disconnects itself once
     *  it has pinned, and on unmanaged, so nothing accumulates. */
    _watch(win) {
        if (!win || !this._titleIds || this._titleIds.has(win))
            return;

        const done = () => {
            const id = this._titleIds?.get(win);
            if (id) {
                try { win.disconnect(id); } catch { /* already gone */ }
                this._titleIds.delete(win);
            }
        };

        const id = win.connect('notify::title', () => {
            if (this._pin(win))
                done();
        });
        this._titleIds.set(win, id);
        win.connect('unmanaged', () => {
            done();
            // Its screen is free again, so the next companion can have it.
            this._placed?.delete(win);
        });

        if (this._pin(win))
            done();
    }

    /** Put the companion bottom-right of a monitor that has not got one.
     *
     *  This exists because on Wayland the BROWSER cannot do it. `chrome.windows
     *  .create({left, top})` is honoured on Windows, macOS and X11, and simply ignored
     *  here: xdg-shell has no request for a client to position its own toplevel, by
     *  design. Only something running inside the compositor can — which is this, the
     *  same place and the same reason `make_above()` lives here.
     *
     *  The work area, not the monitor rectangle: it excludes the top bar and the dock,
     *  which is the difference between "bottom-right" and "underneath the dock".
     *
     *  Placed exactly ONCE per window, on the frame it is recognised. Re-placing on
     *  every title change would drag a companion the user had deliberately moved back
     *  into the corner, which is a fight the user must win. */
    _place(win) {
        if (!this._placed || this._placed.has(win))
            return;

        try {
            const nMonitors = global.display.get_n_monitors();
            const taken = new Set(this._placed.values());
            let monitor = -1;
            for (let i = 0; i < nMonitors; i++) {
                if (!taken.has(i)) { monitor = i; break; }
            }
            // Every screen already has one — leave this extra where the compositor put
            // it rather than stacking it exactly on top of an existing companion.
            if (monitor < 0) {
                this._placed.set(win, win.get_monitor());
                return;
            }

            const area = global.workspace_manager
                .get_active_workspace()
                .get_work_area_for_monitor(monitor);
            const rect = win.get_frame_rect();
            // A window with no size yet cannot be corner-anchored; leave it for the
            // next title change rather than pinning it to a wrong spot.
            if (!rect || rect.width <= 0 || rect.height <= 0)
                return;

            win.move_frame(
                true,
                area.x + area.width - rect.width - PLACE_MARGIN,
                area.y + area.height - rect.height - PLACE_MARGIN,
            );
            this._placed.set(win, monitor);
        } catch {
            // A window that closed mid-placement, or a Shell without move_frame.
            // Costs the automatic placement and nothing else.
        }
    }

    /** Put the window above the others, and in a free screen's corner, if it is the
     *  companion. Returns true once it has done both, which is the signal to stop
     *  watching this window. */
    _pin(win) {
        let title = '';
        try {
            title = (win.get_title() || '').trim();
        } catch {
            return false;
        }
        if (!title.startsWith(COMPANION_TITLE))
            return false;

        try {
            const rect = win.get_frame_rect();
            if (rect.width > MAX_PIN_W || rect.height > MAX_PIN_H)
                return false;
            win.make_above();
            this._place(win);
        } catch {
            // A window that closed mid-check, or a Shell version without
            // make_above. Failing here costs the automatic pin and nothing else —
            // the manual window-manager shortcut still works.
            return false;
        }
        return true;
    }

    /** Recompute the focused application. Called only on a real focus change, so
     *  the /proc read below happens once per switch rather than twice a second. */
    _refresh() {
        this._current = '';
        const win = global.display.focus_window;
        if (!win)
            return;

        const app = Shell.WindowTracker.get_default().get_window_app(win);
        const label = app ? app.get_name() : '';

        // The process name is the identifier, exactly as the X11 helper reports it
        // (/proc/<pid>/comm), so one whitelist serves both session types.
        let pid = 0;
        if (app && typeof app.get_pids === 'function') {
            const pids = app.get_pids();
            if (pids && pids.length > 0)
                pid = pids[0];
        }
        if (!pid && typeof win.get_pid === 'function')
            pid = win.get_pid();
        if (!pid)
            return;

        let comm = '';
        try {
            const [ok, bytes] = GLib.file_get_contents(`/proc/${pid}/comm`);
            if (ok)
                comm = new TextDecoder().decode(bytes).trim();
        } catch {
            // A process that vanished between the focus change and this read.
        }
        if (!comm)
            return;

        this._current = `${comm}|${label || comm}`;
        this._emit();
    }

    /** Milliseconds since the last user input, from Mutter's own idle monitor —
     *  the only source that is correct on a Wayland session. */
    _idleMs() {
        try {
            const monitor = global.backend?.get_core_idle_monitor?.();
            if (monitor)
                return monitor.get_idletime();
        } catch {
            // Reporting 0 means "active", which fails safe: the consumer will
            // simply never see idle rather than idling the user wrongly.
        }
        return 0;
    }

    _payload() {
        return this._current ? `${this._current}|${this._idleMs()}` : '';
    }

    _emit() {
        if (!this._dbus)
            return;
        this._dbus.emit_signal('Focused', new GLib.Variant('(s)', [this._payload()]));
    }
}
