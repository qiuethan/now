#!/bin/sh
# Install a local ActivityWatch module; no website or remote service is changed.
set -eu

if [ "$(uname -s)" != Darwin ]; then
  echo 'This ActivityWatch module requires macOS.' >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BUILD_DIR=$(mktemp -d)
trap 'rm -rf "$BUILD_DIR"' EXIT

swiftc -swift-version 5 -module-cache-path "$BUILD_DIR/cache" \
  "$SCRIPT_DIR/aw-watcher-coding.swift" -o "$BUILD_DIR/aw-watcher-coding"
"$BUILD_DIR/aw-watcher-coding" --self-test
mkdir -p "$HOME/.local/bin"
install -m 755 "$BUILD_DIR/aw-watcher-coding" "$HOME/.local/bin/aw-watcher-coding"

python3 - <<'PY'
from pathlib import Path
import re
import shutil

config = Path.home() / 'Library/Application Support/activitywatch/aw-qt/aw-qt.toml'
config.parent.mkdir(parents=True, exist_ok=True)
backup = config.with_suffix('.toml.before-coding-only')
if config.exists() and not backup.exists():
    shutil.copy2(config, backup)
text = config.read_text() if config.exists() else '[aw-qt]\n'
section = re.search(r'^\[aw-qt\]\s*\n([\s\S]*?)(?=^\[|\Z)', text, re.M)
if not section:
    raise SystemExit('Cannot locate the aw-qt settings; original configuration was preserved.')
body = section.group(1)
setting = 'autostart_modules = ["aw-server", "aw-watcher-coding"]\n'
body = re.sub(r'^autostart_modules\s*=.*\n?', '', body, flags=re.M)
text = text[:section.start(1)] + setting + body + text[section.end(1):]
config.write_text(text)
print('Installed coding-only tracker. Restart ActivityWatch to enable it.')
print('Original configuration backup:', backup)
PY
