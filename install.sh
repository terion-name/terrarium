#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${TERRARIUM_REPO_URL:-https://github.com/terion-name/terrarium.git}"
GITHUB_REPO="${TERRARIUM_GITHUB_REPO:-terion-name/terrarium}"
REF=""
EMBEDDED_BOOTSTRAP_REF="" # TERRARIUM_RELEASE_REF
BOOTSTRAP_REF="${TERRARIUM_BOOTSTRAP_REF:-}"
TMPDIR_PATH=""

if [[ -z "${BOOTSTRAP_REF}" && -n "${EMBEDDED_BOOTSTRAP_REF}" ]]; then
  BOOTSTRAP_REF="${EMBEDDED_BOOTSTRAP_REF}"
fi

usage() {
  cat <<'EOF'
Usage: install.sh [options]

  --ref REF
  --help

All other flags are forwarded to `terrariumctl install`.

Behavior:
  - without --ref, the bootstrap downloads the bundled release when the installer is release-pinned
  - otherwise without --ref, it downloads the latest Terrarium release bundle
  - with a tag-like --ref, it downloads that release bundle
  - with a branch-like --ref (for example main), it falls back to a source build
EOF
}

die() {
  printf '[terrarium-bootstrap] ERROR: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '[terrarium-bootstrap] %s\n' "$*"
}

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    die "run as root"
  fi
}

ensure_os() {
  source /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || die "Ubuntu is required"
  [[ "${VERSION_ID:-}" == "24.04" ]] || die "Ubuntu 24.04 is required"
}

ensure_bootstrap_deps() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y ca-certificates curl unzip python3
}

ensure_git() {
  if command -v git >/dev/null 2>&1; then
    return
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y git
}

ensure_bun() {
  if [[ -x /opt/bun/bin/bun ]]; then
    return
  fi
  mkdir -p /opt/bun
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'x64' ;;
    aarch64|arm64) printf 'arm64' ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
}

is_release_ref() {
  local ref="$1"
  [[ -z "${ref}" ]] && return 0
  [[ "${ref}" =~ ^v?[0-9]+(\.[0-9]+)*([.-][A-Za-z0-9]+)?$ ]]
}

resolve_latest_tag() {
  local arch="$1"
  TERRARIUM_ASSET="terrarium-linux-${arch}.zip" \
    python3 -c '
import json
import os
import sys

asset = os.environ["TERRARIUM_ASSET"]
for release in json.load(sys.stdin):
    if release.get("draft") or release.get("prerelease"):
        continue
    if any(item.get("name") == asset for item in release.get("assets", [])):
        print(release.get("tag_name", ""))
        break
' < <(curl -fsSL "https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=50" 2>/dev/null)
}

parse_args() {
  FORWARD_ARGS=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ref)
        [[ $# -ge 2 ]] || die "--ref requires a value"
        REF="${2:-}"
        shift 2
        ;;
      --ref=*)
        REF="${1#--ref=}"
        shift
        ;;
      --)
        shift
        while [[ $# -gt 0 ]]; do
          FORWARD_ARGS+=("$1")
          shift
        done
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        FORWARD_ARGS+=("$1")
        shift
        ;;
    esac
  done
}

download_release_bundle() {
  local bundle_dir="$1"
  local arch="$2"
  local resolved_ref="$3"
  local asset_url="https://github.com/${GITHUB_REPO}/releases/download/${resolved_ref}/terrarium-linux-${arch}.zip"

  log "downloading Terrarium release bundle ${resolved_ref} (${arch})"
  curl -fsSL "${asset_url}" -o "${bundle_dir}/terrarium.zip" || return 1
  unzip -q "${bundle_dir}/terrarium.zip" -d "${bundle_dir}"
  [[ -x "${bundle_dir}/dist/terrariumctl" ]] || return 1
  run_terrariumctl_install "${bundle_dir}" "${bundle_dir}/dist/terrariumctl" "${resolved_ref}" "${FORWARD_ARGS[@]}"
}

build_from_source() {
  local build_dir="$1"
  local source_ref="$2"

  log "falling back to source build for ref ${source_ref}"
  if [[ -d "${REPO_URL}" ]] || [[ "${REPO_URL}" == file://* ]]; then
    local source_path="${REPO_URL#file://}"
    [[ -d "${source_path}" ]] || die "local Terrarium source path not found: ${source_path}"
    mkdir -p "${build_dir}/repo"
    cp -a "${source_path}/." "${build_dir}/repo/"
  else
    ensure_git
    git clone --depth 1 --branch "${source_ref}" "${REPO_URL}" "${build_dir}/repo"
  fi
  ensure_bun
  (
    cd "${build_dir}/repo"
    /opt/bun/bin/bun install --frozen-lockfile || /opt/bun/bin/bun install --no-progress
    /opt/bun/bin/bun scripts/build.ts
  )
  run_terrariumctl_install "${build_dir}/repo" "${build_dir}/repo/dist/terrariumctl" "${source_ref}" "${FORWARD_ARGS[@]}"
}

is_non_interactive_install() {
  local arg
  for arg in "${FORWARD_ARGS[@]}"; do
    case "${arg}" in
      --non-interactive|--help|-h)
        return 0
        ;;
    esac
  done
  return 1
}

run_terrariumctl_install() {
  local bundle_dir="$1"
  local terrariumctl="$2"
  local ref="$3"
  shift 3

  if [[ -r /dev/tty ]]; then
    TERRARIUM_BUNDLE_DIR="${bundle_dir}" TERRARIUM_REPO_URL="${REPO_URL}" "${terrariumctl}" install --ref "${ref}" "$@" </dev/tty
    return
  fi

  if ! is_non_interactive_install; then
    die "interactive install requires a TTY; run this from an interactive shell or pass --non-interactive with full configuration"
  fi

  TERRARIUM_BUNDLE_DIR="${bundle_dir}" TERRARIUM_REPO_URL="${REPO_URL}" "${terrariumctl}" install --ref "${ref}" "$@"
}

main() {
  local tmpdir arch resolved_ref bootstrap_parent
  parse_args "$@"
  require_root
  ensure_os
  ensure_bootstrap_deps

  bootstrap_parent="/var/lib/terrarium/bootstrap"
  install -d -o root -g root -m 0700 "${bootstrap_parent}"
  TMPDIR_PATH="$(mktemp -d "${bootstrap_parent}/run.XXXXXX")"
  chmod 0700 "${TMPDIR_PATH}"
  trap '[[ -n "${TMPDIR_PATH}" ]] && rm -rf "${TMPDIR_PATH}"' EXIT
  tmpdir="${TMPDIR_PATH}"
  arch="$(detect_arch)"

  if [[ -z "${REF}" ]]; then
    if [[ -n "${BOOTSTRAP_REF}" ]]; then
      download_release_bundle "${tmpdir}" "${arch}" "${BOOTSTRAP_REF}" || die "failed to download Terrarium release bundle ${BOOTSTRAP_REF}"
      exit 0
    fi
    resolved_ref="$(resolve_latest_tag "${arch}")" || die "failed to resolve latest Terrarium release tag"
    [[ -n "${resolved_ref}" ]] || die "failed to resolve latest Terrarium release tag"
    download_release_bundle "${tmpdir}" "${arch}" "${resolved_ref}" || die "failed to download Terrarium release bundle ${resolved_ref}"
    exit 0
  fi

  if is_release_ref "${REF}"; then
    download_release_bundle "${tmpdir}" "${arch}" "${REF}" || die "failed to download Terrarium release bundle ${REF}"
    exit 0
  fi

  build_from_source "${tmpdir}" "${REF}"
}

main "$@"
