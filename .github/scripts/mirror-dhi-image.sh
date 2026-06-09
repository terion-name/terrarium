#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 10 ]; then
  echo "usage: $0 <name> <source-ref> <target-ref> <expected-source-index-digest> <expected-target-index-digest|auto> <required-arches> <description> <original-ref> <original-url> <source-repo-url>" >&2
  exit 2
fi

name="$1"
source_ref="$2"
target_ref="$3"
expected_source_digest="$4"
expected_target_digest="$5"
required_arches_csv="$6"
description="$7"
original_ref="$8"
original_url="$9"
source_repo_url="${10}"

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
if [ "$source_digest" != "$expected_source_digest" ]; then
  echo "source digest mismatch for ${name}: expected ${expected_source_digest}, got ${source_digest}" >&2
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
skopeo copy --retry-times 3 --all "docker://${source_ref}" "docker://${target_ref}"
echo "::endgroup::"

echo "::group::annotate target ${name}"
docker buildx imagetools create \
  --annotation "index:org.opencontainers.image.description=${description}" \
  --annotation "index:org.opencontainers.image.source=${source_repo_url}" \
  --annotation "index:org.opencontainers.image.url=${original_url}" \
  --annotation "index:io.terrarium.dhi.original-ref=${original_ref}" \
  --annotation "index:io.terrarium.dhi.original-url=${original_url}" \
  --tag "${target_ref}" \
  "${target_ref}"
echo "::endgroup::"

echo "::group::verify target ${name}"
skopeo inspect --raw "docker://${target_ref}" >"$target_raw"
target_digest="$(digest_file "$target_raw")"
echo "target ${name} index digest ${target_digest}"
if [ "$expected_target_digest" != "auto" ] && [ "$target_digest" != "$expected_target_digest" ]; then
  echo "target digest mismatch for ${name}: expected ${expected_target_digest}, got ${target_digest}" >&2
  exit 1
fi

if [ "$expected_target_digest" = "auto" ]; then
  echo "::notice title=Final annotated GHCR digest::${target_ref}@${target_digest}"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "| Image | Tag | Final annotated digest |"
      echo "| --- | --- | --- |"
      echo "| ${name} | ${target_ref} | ${target_digest} |"
    } >>"$GITHUB_STEP_SUMMARY"
  fi
fi

jq -e \
  --arg description "$description" \
  --arg source_repo_url "$source_repo_url" \
  --arg original_ref "$original_ref" \
  --arg original_url "$original_url" \
  '.annotations["org.opencontainers.image.description"] == $description
    and .annotations["org.opencontainers.image.source"] == $source_repo_url
    and .annotations["org.opencontainers.image.url"] == $original_url
    and .annotations["io.terrarium.dhi.original-ref"] == $original_ref
    and .annotations["io.terrarium.dhi.original-url"] == $original_url' \
  "$target_raw" >/dev/null

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
echo "target ${name} platform manifests match source"
echo "::endgroup::"
