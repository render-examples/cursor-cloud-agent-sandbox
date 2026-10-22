#!/usr/bin/env bash
set -euo pipefail

# Installs the reviewed Cursor Agent CLI release directly from the versioned
# artifact that https://cursor.com/install selects, using the same layout as
# that installer. Updating the version requires updating both checksums.
readonly CURSOR_AGENT_VERSION="2026.10.19-6bbf2c4"
readonly RELEASE_BASE="https://downloads.cursor.com/lab/${CURSOR_AGENT_VERSION}/linux"
readonly INSTALL_ROOT="$HOME/.local/share/cursor-agent/versions"
readonly BIN_DIR="$HOME/.local/bin"

case "$(uname -m)" in
  x86_64|amd64)
    arch="x64"
    checksum="cf80cc18d8b33bf33e762353977ca1868cfc45290c92c0ffdcef83bb8b37b44f"
    ;;
  aarch64|arm64)
    arch="arm64"
    checksum="71a90f12a8b8183a71442b7ed4037bddc1a0f88114ec4fb9ec92782acb8e7d84"
    ;;
  *)
    echo "Unsupported Linux architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

archive="$(mktemp)"
trap 'rm -f "$archive"' EXIT

curl --fail --silent --show-error --location \
  "${RELEASE_BASE}/${arch}/agent-cli-package.tar.gz" \
  --output "$archive"
printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check -

install_dir="${INSTALL_ROOT}/${CURSOR_AGENT_VERSION}"
rm -rf "$install_dir"
mkdir -p "$install_dir" "$BIN_DIR"
tar --strip-components=1 -xzf "$archive" -C "$install_dir"
ln -sf "$install_dir/cursor-agent" "$BIN_DIR/agent"
ln -sf "$install_dir/cursor-agent" "$BIN_DIR/cursor-agent"
export PATH="$BIN_DIR:$PATH"

installed_version="$(agent --version)"
printf 'Cursor Agent CLI: %s\n' "$installed_version"
if [[ "$installed_version" != *"$CURSOR_AGENT_VERSION"* ]]; then
  echo "Expected Cursor Agent CLI $CURSOR_AGENT_VERSION" >&2
  exit 1
fi
