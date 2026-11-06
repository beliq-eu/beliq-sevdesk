#!/usr/bin/env bash
# The image scan of .github/workflows/docker-publish.yml, for its release and
# its rebuild path alike: it builds each platform of PLATFORMS from <context>
# and scans it before anything is pushed. A pushed tag cannot be recalled from
# the hosts that pulled it.
#
# Fails on a CRITICAL vulnerability that has a fixed version and that
# <ignorefile> does not name. One with no fixed version does not block: no
# rebuild could clear it. Trivy reads the image's Debian packages and its npm
# packages; it reports nothing for the node binary the base installs, so a CVE
# in Node.js itself does not block here. Every platform is scanned before the
# script fails, so the log lists every finding. Findings exit 3, which reads
# apart from a Trivy error (exit 1).
#
# Trivy reads an OCI layout directory, not an OCI tarball, hence tar=false. No
# attestations here, so each layout holds the one image the scan reads. Keep
# the build inputs equal to the push step's, which rebuilds from this build's
# cache, so the layers it pushes are the ones scanned.
#
# Usage: PLATFORMS=linux/amd64,linux/arm64 TRIVY_IMAGE=<tag@digest> \
#   scan-image.sh <context> <ignorefile>

set -euo pipefail

context="${1:?usage: scan-image.sh <context> <ignorefile>}"
ignorefile="${2:?usage: scan-image.sh <context> <ignorefile>}"
: "${PLATFORMS:?}" "${TRIVY_IMAGE:?}" "${RUNNER_TEMP:?}"
[[ -f $ignorefile ]] || {
  echo "::error::no ignore file at $ignorefile, which the scan reads"
  exit 1
}

for platform in ${PLATFORMS//,/ }; do
  docker buildx build --platform "$platform" \
    --provenance=false --sbom=false \
    --output "type=oci,tar=false,dest=$RUNNER_TEMP/scan/${platform//\//-}" "$context"
done

status=0
for platform in ${PLATFORMS//,/ }; do
  rc=0
  docker run --rm \
    -v "$RUNNER_TEMP/scan:/scan:ro" \
    -v "$RUNNER_TEMP/trivy-cache:/root/.cache/trivy" \
    -v "$ignorefile:/cfg/.trivyignore:ro" \
    "$TRIVY_IMAGE" image \
    --input "/scan/${platform//\//-}" \
    --severity CRITICAL \
    --ignore-unfixed \
    --ignorefile /cfg/.trivyignore \
    --scanners vuln \
    --exit-code 3 \
    --no-progress ||
    rc=$?
  case $rc in
    0) ;;
    3)
      echo "::error::$platform: a fixable CRITICAL vulnerability, listed above"
      status=1
      ;;
    *)
      echo "::error::$platform: the scan did not finish (exit $rc), so nothing was checked"
      status=1
      ;;
  esac
done
exit "$status"
