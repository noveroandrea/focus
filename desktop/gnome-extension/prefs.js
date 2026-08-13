/* Focus companion bridge — preferences.
 * ─────────────────────────────────────────────────────────────────────────────
 *  One control, for the one thing here that is genuinely a matter of taste.
 *
 *  Everything else this extension does is a fact rather than a preference — which
 *  window is the companion, which monitor is free, whether it should be on top —
 *  and the project's rule is that facts the machine already knows do not become
 *  settings. How see-through you want a window sitting in the corner of your eye
 *  is not one of those: it depends on the wallpaper behind it, the monitor, and
 *  how much the character is meant to nag you.
 *
 *  It exists at all because the alternative was editing a constant and logging out
 *  — GNOME Shell only loads extension code at start-up, so every experiment cost a
 *  session. A GSetting costs nothing: the extension watches for the change and
 *  repaints the open companions as the slider moves.
 * ───────────────────────────────────────────────────────────────────────────── */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class FocusCompanionPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Companion',
            icon_name: 'preferences-desktop-display-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'Floating companion window',
            description:
                'The compositor applies this, because a browser cannot make its own ' +
                'window see-through. It fades the whole window — the character and the ' +
                'score dim by as much as the panel behind them — so a low value buys a ' +
                'clear view of what is underneath at the cost of the companion catching ' +
                'your eye at all.',
        });

        // A slider rather than a number box: the useful value is whatever looks right
        // against the wallpaper behind it, which is a thing you find by dragging and
        // looking, not by typing. The extension applies each change as it lands, so
        // the window under the dialog is the preview.
        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({ lower: 100, upper: 255, step_increment: 5, page_increment: 20 }),
            digits: 0,
            draw_value: true,
            value_pos: Gtk.PositionType.RIGHT,
            hexpand: true,
            width_request: 260,
            valign: Gtk.Align.CENTER,
        });
        scale.add_mark(180, Gtk.PositionType.BOTTOM, null);
        scale.add_mark(255, Gtk.PositionType.BOTTOM, null);

        const row = new Adw.ActionRow({
            title: 'Opacity',
            subtitle: '100 is faint, 255 is solid. The mark is the default.',
        });
        row.add_suffix(scale);
        group.add(row);
        page.add(group);
        window.add(page);

        settings.bind('companion-opacity', scale.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
    }
}
