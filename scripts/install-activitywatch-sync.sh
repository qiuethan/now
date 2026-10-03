#!/bin/sh
# Install a per-user sync job using the existing gh login; no tokens in files.
set -eu
[ "$(uname -s)" = Darwin ] || { echo 'This installer requires macOS.' >&2; exit 1; }
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SYNC_NODE=$(command -v node)
SYNC_GH=$(command -v gh)
SYNC_REPO=${1:-qiuethan/now}

python3 - "$SCRIPT_DIR" "$SYNC_NODE" "$SYNC_GH" "$SYNC_REPO" <<'PY'
from pathlib import Path
import os, plistlib, shutil, subprocess, sys

source, node, gh, repo = sys.argv[1:]
base = Path.home() / 'Library/Application Support/now-activitywatch'
logs = Path.home() / 'Library/Logs/now-activitywatch'
agents = Path.home() / 'Library/LaunchAgents'
for directory in (base, logs, agents):
    directory.mkdir(parents=True, exist_ok=True)
for name in ('activitywatch.mjs', 'export-activitywatch.mjs'):
    shutil.copy2(Path(source) / name, base / name)
label = 'ca.ethanqiu.now.activitywatch-sync'
plist = agents / (label + '.plist')
job = {
    'Label': label,
    'ProgramArguments': [node, str(base / 'export-activitywatch.mjs'), '--publish', '--repo', repo],
    'RunAtLoad': True,
    'StartInterval': 900,
    'ProcessType': 'Background',
    'EnvironmentVariables': {'PATH': ':'.join(dict.fromkeys([str(Path(gh).parent), str(Path(node).parent), '/usr/bin', '/bin', '/usr/sbin', '/sbin']))},
    'StandardOutPath': str(logs / 'sync.log'),
    'StandardErrorPath': str(logs / 'sync-error.log'),
}
domain = 'gui/' + str(os.getuid())
if plist.exists():
    subprocess.run(['launchctl', 'bootout', domain, str(plist)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
with plist.open('wb') as file:
    plistlib.dump(job, file)
subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], check=True)

# Start ActivityWatch at login. A separate job avoids reopening it every sync
# if the user deliberately quits or pauses collection during a session.
startup = agents / 'ca.ethanqiu.now.activitywatch-start.plist'
if startup.exists():
    subprocess.run(['launchctl', 'bootout', domain, str(startup)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
with startup.open('wb') as file:
    plistlib.dump({'Label': 'ca.ethanqiu.now.activitywatch-start', 'ProgramArguments': ['/usr/bin/open', '-g', '-a', 'ActivityWatch'], 'RunAtLoad': True}, file)
subprocess.run(['launchctl', 'bootstrap', domain, str(startup)], check=True)
print('Installed ActivityWatch sync every 15 minutes and start at login.')
print('Sync logs:', logs)
PY
