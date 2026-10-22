#!/usr/bin/env bash
set -euo pipefail

# Cursor documents https://cursor.com/install as the supported Linux install
# mechanism, but does not document an exact-version selector or artifact
# checksums. Pin the reviewed installer bytes and fail closed when Cursor
# changes them. Updating this file requires reviewing the new official script,
# version, and SHA-256 together.
readonly CURSOR_INSTALLER_URL="https://cursor.com/install"
readonly CURSOR_INSTALLER_SHA256="b0f8a64d91e627aa574964d2e075bb51e15f09bc407ce304d6f1b89ef6bfb080"
readonly CURSOR_AGENT_VERSION="2026.10.19-6bbf2c4"

installer="$(mktemp)"
trap 'rm -f "$installer"' EXIT

curl --fail --silent --show-error --location \
  "$CURSOR_INSTALLER_URL" \
  --output "$installer"

printf '%s  %s\n' "$CURSOR_INSTALLER_SHA256" "$installer" | sha256sum --check -

# Verify that the pinned installer still selects the reviewed CLI release.
if ! grep -Fq "/lab/$CURSOR_AGENT_VERSION/" "$installer"; then
  echo "Pinned Cursor installer no longer selects $CURSOR_AGENT_VERSION" >&2
  exit 1
fi

NO_COLOR=1 bash "$installer"
export PATH="$HOME/.local/bin:$PATH"

installed_version="$(agent --version)"
printf 'Cursor Agent CLI: %s\n' "$installed_version"
if [[ "$installed_version" != *"$CURSOR_AGENT_VERSION"* ]]; then
  echo "Expected Cursor Agent CLI $CURSOR_AGENT_VERSION" >&2
  exit 1
fi
