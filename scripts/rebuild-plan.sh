#!/usr/bin/env bash
# The rebuild path of .github/workflows/docker-publish.yml, up to the build.
#
# It takes the release that `latest` carries and reads three things: that
# release's version and commit from the labels of `latest`, the base `latest`
# was built on, and the base main's Dockerfile pins. When the two bases differ,
# it checks the release's vX.Y.Z tree out into <dir> as tagged, writes main's
# base digest into its FROM lines and nothing else, and prints push=true with
# what the build needs. When they are the same, it prints push=false.
#
# Only the last FROM line counts as the base: it is the stage the image ships.
# The builder stage's layers stay behind, though the splice moves its digest
# too.
#
# Run from a checkout of main with its tags. Output is key=value lines for
# $GITHUB_OUTPUT. Usage: IMAGE=ghcr.io/beliq-eu/beliq-sevdesk rebuild-plan.sh <dir>

set -euo pipefail

image="${IMAGE:?set IMAGE to the image name, without a tag}"
tree="${1:?usage: rebuild-plan.sh <dir for the release tree>}"

fail() {
  echo "::error::$*" >&2
  exit 1
}

# The reference of each FROM line, in order: name:tag@sha256:digest.
from_refs() {
  awk '$1 == "FROM" { print $2 }'
}

# OCI's base.name annotation wants the reference with its registry spelled out.
qualified() {
  local name="$1" first="${1%%/*}"
  if [[ $name != */* ]]; then
    echo "docker.io/library/$name"
  elif [[ $first != *.* && $first != *:* && $first != localhost ]]; then
    echo "docker.io/$name"
  else
    echo "$name"
  fi
}

# Every read of `latest` goes to the one digest it resolves to here.
latest=$(docker buildx imagetools inspect "$image:latest" --format '{{ .Manifest.Digest }}' 2>&1) ||
  fail "could not read $image:latest: $latest"
[[ $latest == sha256:* ]] || fail "$image:latest resolves to '$latest', not a digest"

latest_labels=$(docker buildx imagetools inspect "$image@$latest" \
  --format '{{ json (index .Image "linux/amd64").Config.Labels }}')
version=$(jq -r '.["org.opencontainers.image.version"] // ""' <<<"$latest_labels")
revision=$(jq -r '.["org.opencontainers.image.revision"] // ""' <<<"$latest_labels")

[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  fail "$image:latest carries no X.Y.Z version label (it reads '$version')"
if ! answer=$(docker buildx imagetools inspect "$image:$version" 2>&1 >/dev/null); then
  [[ $answer == *"not found"* ]] && fail "$image:latest says $version, and $image:$version does not exist"
  fail "could not read $image:$version: $answer"
fi
commit=$(git rev-parse -q --verify "refs/tags/v$version^{commit}") ||
  fail "$image:latest says $version, and there is no tag v$version"
[[ $commit == "$revision" ]] ||
  fail "$image:latest names commit $revision, and v$version is $commit"
git merge-base --is-ancestor "$commit" origin/main ||
  fail "v$version ($commit) is not on main"

mapfile -t main_from < <(from_refs <Dockerfile)
mapfile -t tag_from < <(git show "$commit:Dockerfile" | from_refs)
[[ ${#main_from[@]} -gt 0 ]] || fail "main's Dockerfile has no FROM line"
for ref in "${main_from[@]}"; do
  [[ $ref == *@sha256:* ]] || fail "main's FROM $ref names no digest"
done

# Only the digest moves. A new tag or major is a release's to ship.
main_names=$(printf '%s\n' "${main_from[@]%%@*}")
tag_names=$(printf '%s\n' "${tag_from[@]%%@*}")
[[ $main_names == "$tag_names" ]] ||
  fail "main's FROM lines name $(paste -sd' ' <<<"$main_names"), and v$version's name $(paste -sd' ' <<<"$tag_names"). A rebuild changes only the digest; cut a release for this."

base_ref="${main_from[-1]}"
base_name=$(qualified "${base_ref%%@*}")
base_digest="${base_ref#*@}"

# The base `latest` was built on: the annotation a rebuild writes, or for a
# release image, which has none, the digest its own tag's Dockerfile pins.
latest_base=$(docker buildx imagetools inspect "$image@$latest" --raw |
  jq -r '.annotations["org.opencontainers.image.base.digest"] // ""')
if [[ -z $latest_base && ${tag_from[-1]} == *@* ]]; then
  latest_base="${tag_from[-1]#*@}"
fi

if [[ $latest_base == "$base_digest" ]]; then
  echo "::notice::$image:latest ($version) is built on $base_digest already, the base main pins. Nothing to push." >&2
  echo "push=false"
  exit 0
fi

rm -rf "$tree"
git worktree add --detach "$tree" "$commit" >&2

refs=$(printf '%s\n' "${main_from[@]}")
awk -v refs="$refs" '
  BEGIN { split(refs, ref, "\n") }
  $1 == "FROM" { $2 = ref[++n] }
  { print }
' "$tree/Dockerfile" >"$tree/Dockerfile.rebuild"
mv "$tree/Dockerfile.rebuild" "$tree/Dockerfile"

# What the splice must have done: main's FROM references, and every other line
# as tagged.
[[ $(from_refs <"$tree/Dockerfile") == "$refs" ]] || fail "the FROM lines did not take main's digests"
diff <(git show "$commit:Dockerfile" | awk '$1 != "FROM"') <(awk '$1 != "FROM"' "$tree/Dockerfile") >&2 ||
  fail "the splice changed a line other than FROM"

have=$(jq -r .version "$tree/package.json")
[[ $have == "$version" ]] || fail "v$version's package.json says $have"

echo "::notice::rebuilding $version (v$version, $commit) on $base_digest; $image:latest is on ${latest_base:-an unpinned base}" >&2
echo "push=true"
echo "version=$version"
echo "minor=${version%.*}"
echo "commit=$commit"
echo "base-name=$base_name"
echo "base-digest=$base_digest"
echo "context=$tree"
