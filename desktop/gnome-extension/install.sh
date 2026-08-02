#!/bin/sh
# Install the Focus companion bridge into the current user's GNOME Shell.
#
# Two jobs, both of which need code inside the compositor:
#   • report which application has focus (Wayland gives no other way to ask);
#   • keep the extension's floating companion window above other windows, which a
#     browser cannot do for its own window on Wayland.
#
# The first is ONLY NEEDED ON WAYLAND — an X11 (Xorg) session reads the foreground
# window with xprop and needs nothing installed. The second is worth having on
# either session type.
#
# Nothing goes system-wide and nothing needs root: GNOME loads user extensions
# from ~/.local/share/gnome-shell/extensions.
#
# Run from anywhere — paths are resolved relative to this script:
#
#   desktop/gnome-extension/install.sh     (from the repository root)
#   ./install.sh                           (from inside this directory)
set -e

UUID="focus-companion@focus.dev"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

mkdir -p "$DEST"
cp "$SRC/metadata.json" "$SRC/extension.js" "$DEST/"
echo "Installed to $DEST"

# Mark it enabled for the NEXT login.
#
# `gnome-extensions enable` cannot be used here: it asks the running Shell, which
# has no idea this extension exists — it scans the extensions directory only at
# start-up — so it fails with "Extension does not exist" however many times it is
# run. Writing the setting directly is what that command would have done, and the
# Shell reads it when it next starts. So there is no second step.
if command -v gsettings >/dev/null 2>&1; then
  CURRENT=$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null || echo "@as []")
  case "$CURRENT" in
    *"$UUID"*)
      echo "Already marked as enabled."
      ;;
    *)
      # An empty list renders as "[]" or "@as []" (GVariant's empty-array form),
      # where appending before the "]" would leave a stray leading comma.
      case "$CURRENT" in
        "@as []"|"[]") NEW="['$UUID']" ;;
        *) NEW=$(printf '%s' "$CURRENT" | sed "s/\]\$/, '$UUID']/") ;;
      esac
      gsettings set org.gnome.shell enabled-extensions "$NEW"
      echo "Marked as enabled for the next login."
      ;;
  esac
fi

cat <<'EOF'

⚠ LOG OUT AND BACK IN. That is the only remaining step.

  GNOME Shell can be restarted in place on X11 (Alt+F2, "r"), but NOT on Wayland —
  the compositor and the shell are the same process there, so restarting it would
  take your session down with it. Logging out is the only way to load new
  extension code, and the Shell only scans for new extensions at start-up. Until
  then `gnome-extensions enable` will keep answering "Extension does not exist",
  which is expected — the setting above already covers it.

Once you are back, check it with:

  gdbus call --session --dest org.gnome.Shell \
    --object-path /dev/focus/Companion \
    --method dev.focus.Companion.GetFocused

which should print something like ('code|Visual Studio Code|1240',).
Then start the agent:  cd desktop && npm start

The floating companion window will also start pinning itself above other windows —
open it from the extension popup's Working button.

To undo:  gnome-extensions disable focus-companion@focus.dev
          rm -rf ~/.local/share/gnome-shell/extensions/focus-companion@focus.dev
EOF
