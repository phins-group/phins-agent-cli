#!/bin/sh
# Install the reviewed standalone release. No sudo, package manager or API key.
set -eu

main() {
  [ "$#" -eq 0 ] || { printf '%s\n' 'Usage: sh install.sh' >&2; exit 1; }
  die() { printf 'PHINs Agent: %s\n' "$*" >&2; exit 1; }

  os=$(uname -s)
  cpu=$(uname -m)
  case "$os" in
    MINGW*|MSYS*|CYGWIN*)
      command -v powershell.exe >/dev/null 2>&1 || die 'Open Windows Terminal and use the PowerShell command in Quick Start.'
      powershell.exe -NoProfile -Command "& ([scriptblock]::Create((Invoke-RestMethod 'https://raw.githubusercontent.com/phins-group/phins-agent-cli/main/install.ps1')))"
      return
      ;;
    Darwin)
      major=$(sw_vers -productVersion | cut -d. -f1)
      [ "$major" -ge 13 ] || die 'macOS 13 or newer is required.'
      # A Terminal running under Rosetta can still install the native ARM build.
      [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" != 1 ] || cpu=arm64
      os=darwin
      ;;
    Linux) os=linux ;;
    *) die "Unsupported OS: $os. See docs/QUICKSTART.md." ;;
  esac
  case "$cpu" in
    arm64|aarch64) cpu=arm64 ;;
    x86_64|amd64) cpu=x64 ;;
    *) die "Unsupported CPU: $cpu. Supported: ARM64 and x64." ;;
  esac
  target=$os-$cpu
  case "$target" in
    darwin-arm64)
      archive_sha256=a4ba87237b9e9d3efbb9460ba8a4724d1037b44dd6fe69ec70d012e9ed92524d
      binary_sha256=99ef6020208075591e09abfc51af48da6a70e93a20a104a33ff91126a95371fc ;;
    darwin-x64)
      archive_sha256=640d04d36e1449932379bdc4db5f8f5003b8a34dc0bfe383609b48a393e3bbd8
      binary_sha256=fe97e7edbe1a7db8a5537055d15ffd47fc67aa18afc177c6f5d7803f2a2cd032 ;;
    linux-arm64)
      archive_sha256=23717f905a116ef07758a3283e2891cf17c57116e74a97cef9241dcda667b7d9
      binary_sha256=8fa9bddf96080a0fcc60e3edef7e38da293a0a0bdcbeef899ad706d75eaad011 ;;
    linux-x64)
      archive_sha256=bf492fd04257f81099b311d39f233191245f3a59a5e0f28023a04d38d37a3b9f
      binary_sha256=172c563db4f7a3efe85adf8463a85591fcba13b10344fe15abdaf7b6f96142af ;;
  esac
  for tool in curl tar mktemp cut awk; do
    command -v "$tool" >/dev/null 2>&1 || die "Required tool missing: $tool."
  done
  if command -v sha256sum >/dev/null 2>&1; then
    digest() { sha256sum < "$1" | cut -d ' ' -f1; }
  elif command -v shasum >/dev/null 2>&1; then
    digest() { shasum -a 256 < "$1" | cut -d ' ' -f1; }
  else
    die 'A SHA-256 tool is required: sha256sum or shasum.'
  fi
  [ -n "${HOME-}" ] || die 'HOME is not set.'
  case "$HOME" in /*) ;; *) die 'HOME must be an absolute path.' ;; esac
  umask 077
  label=phins-0.1.1-local-$target
  base=$HOME/.local/share/phins-agent-cli
  bin=$HOME/.local/bin
  bundle=$base/$label
  command_path=$bin/phins
  [ ! -L "$base" ] && [ ! -L "$bin" ] || die 'Installation directories must not be symbolic links.'
  mkdir -p "$base" "$bin"
  if [ -e "$command_path" ] || [ -L "$command_path" ]; then
    [ -L "$command_path" ] && [ "$(readlink "$command_path")" = "$bundle/phins" ] || die "Existing command preserved: $command_path."
  fi
  if [ -e "$bundle" ] || [ -L "$bundle" ]; then
    [ -d "$bundle" ] && [ ! -L "$bundle" ] && [ ! -L "$bundle/phins" ] && [ -f "$bundle/.phins-install" ] || die "Existing directory preserved: $bundle."
    [ "$(cat "$bundle/.phins-install")" = "$archive_sha256" ] && [ "$(digest "$bundle/phins")" = "$binary_sha256" ] || die "Existing installation changed; preserved: $bundle."
    printf 'PHINs Agent is already installed (%s).\n' "$target"
  else
    stage=$(mktemp -d "$base/.install.XXXXXX")
    cleanup() { rm -rf "$stage"; }
    trap cleanup 0
    trap 'exit 1' HUP INT TERM
    printf 'Downloading PHINs Agent 0.1.1 for %s…\n' "$target"
    curl -fL --retry 2 --connect-timeout 15 --max-time 300 \
      "https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.1/$label.tar.gz" -o "$stage/release.tar.gz"
    [ "$(digest "$stage/release.tar.gz")" = "$archive_sha256" ] || die 'Archive checksum mismatch; nothing installed.'
    tar -tzf "$stage/release.tar.gz" > "$stage/files"
    awk -v prefix="$label/" 'index($0, prefix) != 1 || $0 ~ /(^|\/)\.\.(\/|$)/ { exit 1 }' "$stage/files" || die 'Unsafe archive paths.'
    tar -xzf "$stage/release.tar.gz" -C "$stage"
    [ -f "$stage/$label/phins" ] && [ ! -L "$stage/$label/phins" ] || die 'Archive executable missing.'
    [ "$(digest "$stage/$label/phins")" = "$binary_sha256" ] || die 'Executable checksum mismatch.'
    chmod 755 "$stage/$label/phins"
    "$stage/$label/phins" --version || die 'This binary cannot run on your OS; Linux needs glibc 2.30+ (not musl).'
    printf '%s\n' "$archive_sha256" > "$stage/$label/.phins-install"
    [ ! -e "$bundle" ] && [ ! -L "$bundle" ] || die 'Another installation appeared; preserved.'
    mv "$stage/$label" "$bundle"
    cleanup
    trap - 0 HUP INT TERM
  fi
  [ -L "$command_path" ] || ln -s "$bundle/phins" "$command_path"
  printf 'Installed: %s\nDemo files: %s\n' "$command_path" "$bundle"
  printf 'Run: "%s"\n' "$command_path"
}

main "$@"
