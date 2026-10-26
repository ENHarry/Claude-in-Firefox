#!/usr/bin/env bash
# Registers the native messaging host with Firefox on macOS/Linux.
# Run this once, after `cd host && npm install`.
set -euo pipefail

HOST_NAME="com.anthropic.claude_in_firefox"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DIR="$SCRIPT_DIR/host"
WRAPPER="$HOST_DIR/host-wrapper.sh"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is not on your PATH. Install Node.js 18+ first." >&2
  exit 1
fi

cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
exec node "$HOST_DIR/native-host.js"
EOF
chmod +x "$WRAPPER"

UNAME="$(uname -s)"
if [ "$UNAME" = "Darwin" ]; then
  TARGET_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
elif [ "$UNAME" = "Linux" ]; then
  TARGET_DIR="$HOME/.mozilla/native-messaging-hosts"
else
  echo "Unsupported OS for install.sh. On Windows, use install.ps1 instead." >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
cat > "$TARGET_DIR/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Claude in Firefox native messaging host",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_extensions": ["claude-in-firefox@local.connector"]
}
EOF

echo "Registered native messaging host manifest at:"
echo "  $TARGET_DIR/$HOST_NAME.json"
echo
echo "Next steps:"
echo "  1) cd host && npm install   (if you haven't already)"
echo "  2) In Firefox: about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> select extension/manifest.json"
echo "  3) claude mcp add claude-in-firefox -- node \"$HOST_DIR/mcp-server.js\""
echo
echo "Note: 'Load Temporary Add-on' clears when Firefox restarts. See README.md for a persistent option."
