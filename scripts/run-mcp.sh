#!/bin/sh
# Launcher for macOS and other Unix systems. Mirrors scripts/run-mcp.ps1 step for
# step, and deliberately keeps the same order and the same refusals: a corrupted
# configuration should fail loudly here rather than reach the network with rubbish in
# it, and that reasoning is not platform-specific.
#
# The one genuine difference is where the password lives. Windows encrypts it with
# DPAPI and stores the ciphertext in live-config.json; here it is in the login
# Keychain (macOS) or the Secret Service keyring via `secret-tool` (Linux), and the
# config file holds no secret at all.
#
# POSIX sh on purpose. macOS ships bash 3.2 from 2007, and nothing below needs more
# than sh gives.

set -eu

# CDPATH is cleared for the duration of the cd: if the user has one set, `cd` can
# resolve a relative path somewhere else entirely and print where it went. Quoted
# empty string rather than a bare `CDPATH=`, which reads as a typo to shellcheck.
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
project_root=$(dirname -- "$script_dir")
entry_point="$project_root/dist/mcp/main.js"

case "$(uname -s)" in
    Darwin)
        data_directory="$HOME/Library/Application Support/CronometerPersonalMcp"
        expected_source="keychain"
        setup_script="scripts/setup-macos.sh"
        ;;
    *)
        data_directory="${XDG_DATA_HOME:-$HOME/.local/share}/CronometerPersonalMcp"
        expected_source="libsecret"
        setup_script="scripts/setup-linux.sh"
        ;;
esac
configuration_path="$data_directory/live-config.json"
keychain_service="cronometer-personal-mcp"

die() {
    printf '%s\n' "$*" >&2
    exit 1
}

[ -f "$entry_point" ] || die "Cronometer MCP is not built. Run $setup_script first."
[ -f "$configuration_path" ] || die "Cronometer MCP is not configured. Run $setup_script first."

# The counterpart of the Windows ACL check, and it matters more than it looks:
# ~/Library/Application Support is not private by default the way %LOCALAPPDATA% is.
# This directory holds the session cookie and the downloaded diary exports, so an
# inherited-open mode would expose both to every other account on the machine.
if [ "$(uname -s)" = "Darwin" ]; then
    mode=$(stat -f '%Lp' "$data_directory")
else
    mode=$(stat -c '%a' "$data_directory")
fi
[ "$mode" = "700" ] || die "The Cronometer data directory is mode $mode, not 700: $data_directory. Re-run $setup_script to restrict it."

# Validation lives in Node because node is already required to run the server, and
# because a shell-only JSON parser is a bug waiting to happen. Three lines out, in a
# fixed order, every one of them checked to hold no newline.
configuration=$(node "$script_dir/lib/read-live-config.mjs" "$configuration_path") || exit 1
username=$(printf '%s\n' "$configuration" | sed -n '1p')
timezone=$(printf '%s\n' "$configuration" | sed -n '2p')
credential_source=$(printf '%s\n' "$configuration" | sed -n '3p')

[ "$credential_source" = "$expected_source" ] || die "This configuration stores its password with '$credential_source', which this launcher cannot read. It was written on another platform; re-run $setup_script on this machine."

# Read into a variable rather than exported straight away, so a keyring denial is
# reported as itself instead of as a Cronometer sign-in failure ten seconds later.
# The Keychain, or a locked KDE Wallet / GNOME Keyring, may prompt on first run: that
# is the system working.
if [ "$credential_source" = "keychain" ]; then
    password=$(security find-generic-password -s "$keychain_service" -a "$username" -w 2>/dev/null) \
        || die "No Cronometer password found in the Keychain for $username. Re-run $setup_script."
else
    password=$(secret-tool lookup service "$keychain_service" account "$username" 2>/dev/null) \
        || die "No Cronometer password found in the Secret Service keyring for $username. Re-run $setup_script."
fi
[ -n "$password" ] || die "The stored Cronometer password is empty. Re-run $setup_script."

# Cleared on every exit path, including a signal. The variables are process-local, so
# this guards against nothing but a shell that keeps running — which is exactly what
# happens when this is sourced by accident rather than executed.
cleanup() {
    unset CRONOMETER_PASSWORD CRONOMETER_USERNAME CRONOMETER_LIVE_ENABLED \
          CRONOMETER_TIMEZONE CRONOMETER_DATA_DIR CRONOMETER_EXPORT_DIR CRONOMETER_PYTHON
    password=
}
trap cleanup EXIT HUP INT TERM

CRONOMETER_LIVE_ENABLED=1
CRONOMETER_USERNAME="$username"
CRONOMETER_PASSWORD="$password"
CRONOMETER_TIMEZONE="$timezone"
CRONOMETER_DATA_DIR="$data_directory"
# Downloaded exports are the whole diary, per meal, so they live inside the same
# protected directory as the credentials rather than wherever a browser put them. The
# server refuses to read exports at all if this is unset — it will not guess a
# location for files like these.
CRONOMETER_EXPORT_DIR="$data_directory/exports"
CRONOMETER_PYTHON="$project_root/.venv-live/bin/python"
export CRONOMETER_LIVE_ENABLED CRONOMETER_USERNAME CRONOMETER_PASSWORD \
       CRONOMETER_TIMEZONE CRONOMETER_DATA_DIR CRONOMETER_EXPORT_DIR CRONOMETER_PYTHON

password=

exec node "$entry_point"
