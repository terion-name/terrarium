#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: build-cockpit-plugins-bundle.sh --output PATH [options]

Options:
  --output PATH
  --zfs-repo URL
  --zfs-ref REF
  --s3-repo URL
  --s3-ref REF

The script builds the pinned Cockpit plugins into /usr/share/cockpit inside the
current Linux environment and then packages the install tree as a tarball.
EOF
}

OUTPUT=""
ZFS_REPO="https://github.com/45Drives/cockpit-zfs.git"
ZFS_REF="53049cad63a45da1999376e811acef5b85af042a"
S3_REPO="https://github.com/45Drives/cockpit-S3ObjectBroswer.git"
S3_REF="8ff0bf98816cd6c03b9f82ccc21ecfd473e801d9"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      OUTPUT="${2:-}"
      shift 2
      ;;
    --output=*)
      OUTPUT="${1#--output=}"
      shift
      ;;
    --zfs-repo)
      ZFS_REPO="${2:-}"
      shift 2
      ;;
    --zfs-repo=*)
      ZFS_REPO="${1#--zfs-repo=}"
      shift
      ;;
    --zfs-ref)
      ZFS_REF="${2:-}"
      shift 2
      ;;
    --zfs-ref=*)
      ZFS_REF="${1#--zfs-ref=}"
      shift
      ;;
    --s3-repo)
      S3_REPO="${2:-}"
      shift 2
      ;;
    --s3-repo=*)
      S3_REPO="${1#--s3-repo=}"
      shift
      ;;
    --s3-ref)
      S3_REF="${2:-}"
      shift 2
      ;;
    --s3-ref=*)
      S3_REF="${1#--s3-ref=}"
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

if [[ -z "${OUTPUT}" ]]; then
  printf 'Missing required --output\n' >&2
  usage >&2
  exit 1
fi

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
rm -rf /usr/local/src/cockpit-zfs /usr/local/src/cockpit-S3ObjectBroswer

git clone "${ZFS_REPO}" /usr/local/src/cockpit-zfs
git -C /usr/local/src/cockpit-zfs checkout "${ZFS_REF}"
(cd /usr/local/src/cockpit-zfs && corepack enable && make install RESTART_COCKPIT=0)

git clone "${S3_REPO}" /usr/local/src/cockpit-S3ObjectBroswer
git -C /usr/local/src/cockpit-S3ObjectBroswer checkout "${S3_REF}"
(cd /usr/local/src/cockpit-S3ObjectBroswer && corepack enable && make install RESTART_COCKPIT=0)

mkdir -p "$(dirname "${OUTPUT}")"
tar -czf "${OUTPUT}" \
  -C / \
  usr/share/cockpit/zfs \
  usr/share/cockpit/cockpit-s3-browser
