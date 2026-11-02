#!/bin/sh
# Installs the spotter command for the current user on a Mac. It asks for no password and writes only under $HOME.
#
#   curl -fsSL https://spotter.pisspoursoftware.xyz/install | sh
#   curl -fsSL https://spotter.pisspoursoftware.xyz/install | sh -s -- --dry-run
#   curl -fsSL https://spotter.pisspoursoftware.xyz/install | sh -s -- --uninstall
#
# Options: --dry-run, --uninstall, --no-setup, --no-modify-path.
#
# Everything happens from main, on the last line, so a download cut short runs nothing.

set -eu

# The release stamps the version and the two checksums.
VERSION=0.1.2
SHA256_ARM64=630ab26f49b069e8190273b69e0ee3ba6f8fc7a9c40c86eee21417f199d8392e
SHA256_X64=ee2611e8d0caac64393fdbae45245a6a1c4a28e3c65633d0d9ca3637169dca0e
# Cloudflare first. GitHub keeps every release, and sent this file at 140 KB/s where Cloudflare sent 12 MB/s (2026-11-01).
BASE_URL=https://spotter.pisspoursoftware.xyz/download/v$VERSION
FALLBACK_URL=https://github.com/Piss-Pour-Software/spotter/releases/download/v$VERSION

NAME=spotter
# The phone app the words come from: the TestFlight beta until the App Store page is live.
APP_LINK=https://testflight.apple.com/join/nUxAwCM6
APP_HINT="On your Home Screen it is called Scribe for now."
BIN_DIR="$HOME/.local/bin"
BIN="$BIN_DIR/$NAME"
MARK="# added by the $NAME installer"

say() { printf '%s\n' "$*"; }
fail() {
  printf '%s install: %s\n' "$NAME" "$*" >&2
  exit 1
}

# A shell under Rosetta reports x86_64 on an Apple silicon Mac, so the hardware is asked first.
detect_target() {
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
    say arm64
    return
  fi
  case "$(uname -m)" in
    arm64) say arm64 ;;
    x86_64) say x64 ;;
    *) fail "this processor ($(uname -m)) has no build" ;;
  esac
}

# Asked from the filesystem's root. A copy from before 0.1.2 reads bunfig.toml and .env from the folder it starts in, and the folder this
# script runs in may be anyone's.
version_of() { (cd / && "$1" --version 2>/dev/null) || true; }

expected_sum() {
  case "$1" in
    arm64) say "$SHA256_ARM64" ;;
    x64) say "$SHA256_X64" ;;
  esac
}

# No fixed time limit on a 15 MB file: a slow line is fine. Five seconds under 1 KB/s is a stall, and it fails. A floor
# of 1 B/s would take twice that, because curl measures speed over its last five seconds.
download() {
  case "$1" in
    https://*) protocol='=https' ;;
    http://127.0.0.1*) protocol='=http' ;;
    *) fail "downloads go only over https, not $1" ;;
  esac
  progress=--silent
  if [ -t 2 ]; then progress=--progress-bar; fi
  curl --fail --location "$progress" --show-error --proto "$protocol" --proto-redir "$protocol" \
    --connect-timeout 5 --speed-limit 1024 --speed-time 5 --output "$2" "$1"
}

# Either place can be slow, down or wrong: a file counts only if it matches the checksum in this script.
fetch_release() {
  for place in "$BASE_URL" "$FALLBACK_URL"; do
    if download "$place/$1" "$3"; then
      got=$(shasum -a 256 "$3" | cut -d ' ' -f 1)
      if [ "$got" = "$2" ]; then return 0; fi
      problem="the download's checksum is wrong, so nothing was installed: expected $2, got $got"
    else
      problem="could not download $place/$1. Check the network and run this again."
    fi
  done
  fail "$problem"
}

rc_file() {
  case "${SHELL:-}" in
    */zsh) say "$HOME/.zshrc" ;;
    */bash) say "$HOME/.bash_profile" ;;
    *) say "" ;;
  esac
}

path_line() { printf 'export PATH="%s:$PATH" %s' "$BIN_DIR" "$MARK"; }

on_path() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) return 0 ;;
    *) return 1 ;;
  esac
}

add_to_path() {
  if on_path; then return; fi
  rc=$(rc_file)
  if [ "$MODIFY_PATH" = 0 ] || [ -z "$rc" ]; then
    say "Add this line to your shell's startup file: $(path_line)"
    return
  fi
  if [ -f "$rc" ] && grep -q -F "$MARK" "$rc"; then return; fi
  say "$(path_line)" >>"$rc"
  say "Added $BIN_DIR to your PATH in $rc. Open a new terminal to use it there."
}

# Written back through the same file, not moved over it, so a .zshrc that is a link stays a link.
remove_from_path() {
  rc=$(rc_file)
  if [ -z "$rc" ] || [ ! -f "$rc" ] || ! grep -q -F "$MARK" "$rc"; then return 0; fi
  kept=$(mktemp)
  grep -v -F "$MARK" "$rc" >"$kept" || true
  cat "$kept" >"$rc"
  rm -f "$kept"
  say "Removed the PATH line from $rc."
}

uninstall() {
  if [ -x "$BIN" ]; then (cd / && "$BIN" logout >/dev/null 2>&1) || true; fi
  rm -f "$BIN"
  remove_from_path
  say "Removed $NAME and its sign-in from this Mac."
}

next_step() {
  say "$NAME follows what Vakyume records on your iPhone. If Vakyume is not on your phone yet: $APP_LINK"
  say "$APP_HINT"
  say "Next: run $BIN setup"
}

# curl | sh gives the script the pipe as its input, so setup reads the terminal itself.
run_setup() {
  if [ "$SETUP" = 0 ]; then
    next_step
  elif (: </dev/tty) 2>/dev/null; then
    "$BIN" setup </dev/tty || say "Setup stopped. Run $BIN setup to try again."
  else
    next_step
  fi
}

install_release() {
  target=$1
  archive="$NAME-$VERSION-darwin-$target.tar.xz"
  want=$(expected_sum "$target")
  if [ "$DRY_RUN" = 1 ]; then
    say "This would download $BASE_URL/$archive,"
    say "or the same file from $FALLBACK_URL/$archive,"
    say "check it against sha256 $want, install it at $BIN,"
    on_path || say "add $BIN_DIR to your PATH in $(rc_file),"
    say "and start setup. Nothing has changed."
    return
  fi
  if [ -x "$BIN" ] && [ "$(version_of "$BIN")" = "$NAME $VERSION" ]; then
    say "$NAME $VERSION is already installed at $BIN."
    add_to_path
    run_setup
    return
  fi
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT INT TERM
  say "Downloading $archive"
  fetch_release "$archive" "$want" "$work/$archive"
  mkdir "$work/unpacked"
  tar -xf "$work/$archive" -C "$work/unpacked"
  if [ "$(version_of "$work/unpacked/$NAME")" != "$NAME $VERSION" ]; then
    fail "the downloaded program does not run on this Mac, so nothing was installed"
  fi
  mkdir -p "$BIN_DIR"
  # Copied beside its final place, then renamed, so a running copy is never half written.
  cp "$work/unpacked/$NAME" "$BIN_DIR/.$NAME.new"
  chmod 755 "$BIN_DIR/.$NAME.new"
  mv -f "$BIN_DIR/.$NAME.new" "$BIN"
  say "Installed $NAME $VERSION at $BIN."
  add_to_path
  run_setup
}

main() {
  DRY_RUN=0
  SETUP=1
  MODIFY_PATH=1
  action=install
  for argument in "$@"; do
    case "$argument" in
      --dry-run) DRY_RUN=1 ;;
      --no-setup) SETUP=0 ;;
      --no-modify-path) MODIFY_PATH=0 ;;
      --uninstall) action=uninstall ;;
      *) fail "unknown option $argument" ;;
    esac
  done
  if [ "$action" = uninstall ]; then
    uninstall
    return
  fi
  if [ "$(uname -s)" != Darwin ]; then fail "macOS only for now"; fi
  install_release "$(detect_target)"
}

main "$@"
