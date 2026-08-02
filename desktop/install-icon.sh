#!/bin/sh
# Put a "Focus agent" icon where you click icons — the applications menu and the
# desktop on Linux, ~/Applications on macOS. Clicking it starts the agent.
#
# Run once:   ./install-icon.sh
# Undo:       ./install-icon.sh --uninstall
#
# Nothing here needs root, and nothing is written outside your home directory.
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LAUNCH="$DIR/launch.sh"
ICON="$DIR/icon.svg"
OS=$(uname -s)

chmod +x "$LAUNCH" 2>/dev/null || true

# ── Linux ─────────────────────────────────────────────────────────────────────
install_linux() {
  APPS="$HOME/.local/share/applications"
  ENTRY="$APPS/focus-agent.desktop"
  mkdir -p "$APPS"

  # Absolute paths on purpose: a .desktop file is launched from an unspecified
  # working directory, so a relative Exec would work from a terminal and fail from
  # the menu — the one place it has to work.
  cat > "$ENTRY" <<EOF
[Desktop Entry]
Type=Application
Name=Focus agent
Comment=Let the Focus extension see which program you are working in
Exec=$LAUNCH
Icon=$ICON
Terminal=false
Categories=Utility;
StartupNotify=false
Actions=Stop;

[Desktop Action Stop]
Name=Stop the agent
Exec=$LAUNCH stop
EOF
  chmod +x "$ENTRY"

  # The desktop copy is a separate file, not a symlink: GNOME's "allow launching"
  # trust flag is metadata on the file you double-click.
  if [ -d "$HOME/Desktop" ]; then
    cp "$ENTRY" "$HOME/Desktop/focus-agent.desktop"
    chmod +x "$HOME/Desktop/focus-agent.desktop"
    # Without this GNOME shows the entry as untrusted and refuses to run it.
    command -v gio >/dev/null 2>&1 &&
      gio set "$HOME/Desktop/focus-agent.desktop" metadata::trusted true 2>/dev/null || true
  fi

  command -v update-desktop-database >/dev/null 2>&1 &&
    update-desktop-database "$APPS" 2>/dev/null || true

  # Same file again, in the directory the session runs at login. Opt-in: clicking an
  # icon is a decision, starting with the session is a different one.
  if [ "${AUTOSTART:-0}" = "1" ]; then
    mkdir -p "$HOME/.config/autostart"
    cp "$ENTRY" "$HOME/.config/autostart/focus-agent.desktop"
  fi

  echo "Installed:"
  echo "  $ENTRY"
  [ -f "$HOME/Desktop/focus-agent.desktop" ] && echo "  $HOME/Desktop/focus-agent.desktop"
  [ "${AUTOSTART:-0}" = "1" ] && echo "  $HOME/.config/autostart/focus-agent.desktop  (starts at login)"
  echo
  echo 'Search "Focus agent" in your applications, or double-click it on the desktop.'
  echo 'Right-click the icon → "Stop the agent" to stop it.'
  [ "${AUTOSTART:-0}" = "1" ] || echo 'To start it automatically at login: ./install-icon.sh --autostart'
}

uninstall_linux() {
  rm -f "$HOME/.local/share/applications/focus-agent.desktop" \
        "$HOME/Desktop/focus-agent.desktop" \
        "$HOME/.config/autostart/focus-agent.desktop"
  echo "Removed the Focus agent icon. The agent itself is untouched — stop it with:"
  echo "  $LAUNCH stop"
}

# ── macOS ─────────────────────────────────────────────────────────────────────
# A .app bundle is just a directory with a known shape, so no compiler and no
# developer account is involved: the "binary" is a two-line shell script.
install_macos() {
  APP="$HOME/Applications/Focus agent.app"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

  cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Focus agent</string>
  <key>CFBundleIdentifier</key><string>dev.focus.agent</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>focus-agent</string>
  <!-- No window, no Dock tile: this is a launcher, not an application you switch to. -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
EOF

  cat > "$APP/Contents/MacOS/focus-agent" <<EOF
#!/bin/sh
exec "$LAUNCH" "\$@"
EOF
  chmod +x "$APP/Contents/MacOS/focus-agent"

  echo "Installed: $APP"
  echo
  echo 'Open it from Launchpad or ~/Applications. To have it start with your session,'
  echo 'add it in System Settings → General → Login Items.'
  echo "To stop the agent: $LAUNCH stop"
}

uninstall_macos() {
  rm -rf "$HOME/Applications/Focus agent.app"
  echo "Removed the Focus agent app. Stop the agent itself with: $LAUNCH stop"
}

AUTOSTART=0
case "${1:-install}" in --autostart|autostart) AUTOSTART=1 ;; esac
export AUTOSTART

case "${1:-install}" in
  --uninstall|uninstall)
    case "$OS" in Darwin) uninstall_macos ;; *) uninstall_linux ;; esac
    ;;
  *)
    [ -f "$ICON" ] || { echo "Missing $ICON — run this from the desktop/ folder." >&2; exit 1; }
    case "$OS" in
      Darwin) install_macos ;;
      Linux)  install_linux ;;
      *) echo "Unsupported here. On Windows run install-icon.ps1 instead." >&2; exit 1 ;;
    esac
    ;;
esac
