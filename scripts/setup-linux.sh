#!/bin/sh
# Builds, tests and configures the connector on Linux, mirroring scripts/setup-macos.sh
# step for step: install, build, test, ask for a timezone, require the literal word
# ENABLE, take the credentials, then offer client registration.
#
# Two things differ from macOS. The password goes into the Secret Service keyring
# (KDE Wallet or GNOME Keyring) through `secret-tool` instead of the login Keychain,
# and the data directory follows XDG. Claude Desktop has no official Linux build, so
# only Codex and Claude Code are offered.
#
# POSIX sh, like the other shell scripts here.

set -eu

# See the note in run-mcp.sh: a user's CDPATH can send a relative `cd` elsewhere.
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
project_root=$(dirname -- "$script_dir")
venv="$project_root/.venv-live"
python="$venv/bin/python"
lock_file="$project_root/python/requirements-live.lock"
runner="$script_dir/run-mcp.sh"
data_directory="${XDG_DATA_HOME:-$HOME/.local/share}/CronometerPersonalMcp"
configuration_path="$data_directory/live-config.json"
keychain_service="cronometer-personal-mcp"

skip_client_registration=${SKIP_CLIENT_REGISTRATION:-0}

die() {
    printf '%s\n' "$*" >&2
    exit 1
}

ask() {
    # Reads from the terminal rather than stdin, so this still works when the script
    # itself is piped in.
    printf '%s' "$1" >&2
    IFS= read -r reply < /dev/tty || die "No terminal available to read from."
    printf '%s' "$reply"
}

ask_yes_no() {
    answer=$(ask "$1 [y/N] ")
    case "$answer" in
        [Yy]|[Yy][Ee][Ss]) return 0 ;;
        *) return 1 ;;
    esac
}

[ "$(uname -s)" = "Linux" ] || die "This setup script is for Linux. On macOS use scripts/setup-macos.sh."

for command in node npm uv secret-tool; do
    command -v "$command" > /dev/null 2>&1 || die "$command is required but was not found on PATH."
done

cd "$project_root"
npm ci
[ -x "$python" ] || uv venv "$venv" --python 3.12
uv pip sync "$lock_file" --python "$python" --require-hashes
npm run typecheck
npm test
npm run test:python

timezone=$(ask 'Cronometer diary IANA timezone [America/New_York — Recommended]: ')
[ -n "$timezone" ] || timezone='America/New_York'
node -e 'new Intl.DateTimeFormat("en-US",{timeZone:process.argv[1]}).format(new Date())' "$timezone" \
    || die "That is not a timezone this machine recognises: $timezone"

printf '\n%s\n' 'Live access uses an unsupported Cronometer web interface. It may break, and Cronometer could restrict the account.'
enable=$(ask 'Type ENABLE to accept that risk and enable live read/write access: ')
[ "$enable" = "ENABLE" ] || die "Live access was not enabled. No credential configuration was written."

if [ -f "$configuration_path" ]; then
    ask_yes_no 'Replace the saved Cronometer sign-in?' || die "The existing sign-in was left unchanged."
fi

username=$(ask 'Cronometer username or email: ')
[ -n "$username" ] || die "A valid Cronometer username or email is required."
[ "${#username}" -le 320 ] || die "That username is too long to be real."

mkdir -p "$data_directory/exports"
# Before anything is written into it, so the credentials and the downloaded diary are
# never briefly readable by other accounts on the machine.
chmod 700 "$data_directory" "$data_directory/exports"

# `secret-tool store` prompts on the terminal when no value is piped in, so the
# password never appears as an argument in the process table. Storing again under the
# same attributes replaces the existing entry.
printf '\n%s\n' 'Enter the Cronometer password at the prompt. It is not echoed and never appears in the process list.'
secret-tool store --label='Cronometer Personal MCP' service "$keychain_service" account "$username" < /dev/tty \
    || die "The password was not stored in the keyring; nothing was configured."

secret-tool lookup service "$keychain_service" account "$username" > /dev/null 2>&1 \
    || die "The password was stored but could not be read back. Nothing was configured."

# Written by node rather than a heredoc so the values are JSON-escaped properly.
umask 077
node -e '
const [path, timezone, username] = process.argv.slice(1);
require("node:fs").writeFileSync(path, JSON.stringify({
  version: 1,
  live_enabled: true,
  timezone,
  username,
  credential_source: "libsecret",
}, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
' "$configuration_path" "$timezone" "$username"
chmod 600 "$configuration_path"

node "$script_dir/lib/read-live-config.mjs" "$configuration_path" > /dev/null \
    || die "The configuration that was just written does not validate. Fix it before starting the server."

chmod +x "$runner"

printf '\n%s\n' 'The server is built, tested, and configured. No plaintext password was written to the project or to an MCP config.'

[ "$skip_client_registration" = "0" ] || exit 0

if command -v codex > /dev/null 2>&1; then
    if ask_yes_no 'Register cronometer-personal with Codex for this account?'; then
        if codex mcp get cronometer-personal > /dev/null 2>&1; then
            printf '%s\n' 'Codex already has an MCP server named cronometer-personal; it was not overwritten.'
        else
            codex mcp add cronometer-personal -- "$runner"
        fi
        config_toml="$HOME/.codex/config.toml"
        if grep -q '^\[mcp_servers.cronometer-personal\]' "$config_toml" 2>/dev/null &&
           ! grep -q '^default_tools_approval_mode' "$config_toml" 2>/dev/null; then
            printf '%s\n' 'Add this line under [mcp_servers.cronometer-personal] in ~/.codex/config.toml:'
            printf '%s\n' '    default_tools_approval_mode = "writes"'
            printf '%s\n' 'Until you do, account-changing tools may run without asking.'
        fi
    fi
fi

if command -v claude > /dev/null 2>&1; then
    if ask_yes_no 'Register cronometer-personal with Claude Code for this account?'; then
        if claude mcp get cronometer-personal > /dev/null 2>&1; then
            printf '%s\n' 'Claude Code already has an MCP server named cronometer-personal; it was not overwritten.'
        else
            claude mcp add --scope user cronometer-personal -- "$runner"
        fi
    fi
fi
