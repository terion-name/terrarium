#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: $0 <name> <source-ref> <target-ref> <expected-index-digest> <required-arches>" >&2
  exit 2
fi

name="$1"
source_ref="$2"
target_ref="$3"
expected_digest="$4"
required_arches_csv="$5"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

digest_file() {
  sha256sum "$1" | awk '{ print "sha256:" $1 }'
}

source_raw="$tmpdir/source.json"
target_raw="$tmpdir/target.json"

echo "::group::inspect source ${name}"
skopeo inspect --raw "docker://${source_ref}" >"$source_raw"
source_digest="$(digest_file "$source_raw")"
if [ "$source_digest" != "$expected_digest" ]; then
  echo "source digest mismatch for ${name}: expected ${expected_digest}, got ${source_digest}" >&2
  exit 1
fi

if ! jq -e '.manifests and (.manifests | length > 0)' "$source_raw" >/dev/null; then
  echo "source ${name} is not a multi-arch image index" >&2
  exit 1
fi

IFS=',' read -r -a required_arches <<<"$required_arches_csv"
for arch in "${required_arches[@]}"; do
  if ! jq -e --arg arch "$arch" '.manifests[] | select((.platform.os // "") == "linux" and (.platform.architecture // "") == $arch)' "$source_raw" >/dev/null; then
    echo "source ${name} is missing linux/${arch}" >&2
    exit 1
  fi
done
echo "source ${name} digest ${source_digest} contains ${required_arches_csv}"
echo "::endgroup::"

echo "::group::copy ${name}"
skopeo copy --retry-times 3 --all --preserve-digests "docker://${source_ref}" "docker://${target_ref}"
echo "::endgroup::"

echo "::group::verify target ${name}"
skopeo inspect --raw "docker://${target_ref}" >"$target_raw"
target_digest="$(digest_file "$target_raw")"
if [ "$target_digest" != "$expected_digest" ]; then
  echo "target digest mismatch for ${name}: expected ${expected_digest}, got ${target_digest}" >&2
  exit 1
fi

for arch in "${required_arches[@]}"; do
  source_arch_digest="$(jq -r --arg arch "$arch" '.manifests[] | select((.platform.os // "") == "linux" and (.platform.architecture // "") == $arch) | .digest' "$source_raw" | head -n1)"
  target_arch_digest="$(jq -r --arg arch "$arch" '.manifests[] | select((.platform.os // "") == "linux" and (.platform.architecture // "") == $arch) | .digest' "$target_raw" | head -n1)"
  if [ -z "$target_arch_digest" ] || [ "$target_arch_digest" = "null" ]; then
    echo "target ${name} is missing linux/${arch}" >&2
    exit 1
  fi
  if [ "$target_arch_digest" != "$source_arch_digest" ]; then
    echo "target linux/${arch} digest mismatch for ${name}: expected ${source_arch_digest}, got ${target_arch_digest}" >&2
    exit 1
  fi
done
echo "target ${name} digest ${target_digest} matches source"
echo "::endgroup::"
