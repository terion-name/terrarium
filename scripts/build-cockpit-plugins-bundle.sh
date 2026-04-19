#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: build-cockpit-plugins-bundle.sh --plugin NAME --output PATH [options]

Options:
  --plugin NAME
  --output PATH
  --repo URL
  --ref REF

The script builds one Cockpit plugin into /usr/share/cockpit inside the current
Linux environment and then packages that install tree as a tarball.
EOF
}

PLUGIN=""
OUTPUT=""
REPO=""
REF=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plugin)
      PLUGIN="${2:-}"
      shift 2
      ;;
    --plugin=*)
      PLUGIN="${1#--plugin=}"
      shift
      ;;
    --output)
      OUTPUT="${2:-}"
      shift 2
      ;;
    --output=*)
      OUTPUT="${1#--output=}"
      shift
      ;;
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --repo=*)
      REPO="${1#--repo=}"
      shift
      ;;
    --ref)
      REF="${2:-}"
      shift 2
      ;;
    --ref=*)
      REF="${1#--ref=}"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "${PLUGIN}" ]]; then
  printf 'Missing required --plugin\n' >&2
  usage >&2
  exit 1
fi

if [[ -z "${OUTPUT}" ]]; then
  printf 'Missing required --output\n' >&2
  usage >&2
  exit 1
fi

case "${PLUGIN}" in
  zfs)
    : "${REPO:=https://github.com/45Drives/cockpit-zfs.git}"
    : "${REF:=v1.2.21-3}"
    PLUGIN_DIR="/usr/local/src/cockpit-zfs"
    PLUGIN_SHARE_PATH="usr/share/cockpit/zfs"
    ;;
  s3)
    : "${REPO:=https://github.com/45Drives/cockpit-S3ObjectBroswer.git}"
    : "${REF:=v1.1.0-6}"
    PLUGIN_DIR="/usr/local/src/cockpit-S3ObjectBroswer"
    PLUGIN_SHARE_PATH="usr/share/cockpit/cockpit-s3-browser"
    ;;
  *)
    printf 'Unsupported plugin: %s\n' "${PLUGIN}" >&2
    usage >&2
    exit 1
    ;;
esac

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y \
  ca-certificates \
  git \
  jq \
  make \
  moreutils \
  msmtp \
  nodejs \
  npm \
  python3-botocore \
  python3-dateutil \
  python3-libzfs \
  rsync \
  sqlite3

npm install -g corepack
corepack enable

WORKDIR="$(mktemp -d /tmp/terrarium-cockpit-build.XXXXXX)"
trap 'rm -rf "${WORKDIR}"' EXIT

mkdir -p /usr/local/src
rm -rf "${PLUGIN_DIR}"
git clone "${REPO}" "${PLUGIN_DIR}"
git -C "${PLUGIN_DIR}" checkout "${REF}"
(cd "${PLUGIN_DIR}" && corepack enable && make install RESTART_COCKPIT=0)

mkdir -p "$(dirname "${OUTPUT}")"
tar -czf "${OUTPUT}" \
  -C / \
  "${PLUGIN_SHARE_PATH}"
