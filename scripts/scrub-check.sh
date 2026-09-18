#!/usr/bin/env bash
# Fail if an em-dash (U+2014) appears in any file git tracks or would track.
# Org rule: no em-dashes in published or customer-facing text.
#
# Scanning the whole tree instead of a list of directories means a new
# directory is covered the day it is added; a list is how .github/ was missed.
# The character is written as its UTF-8 bytes so this file is not itself a hit
# and the match does not depend on the locale.
set -euo pipefail
cd "$(dirname "$0")/.."

emdash=$'\xe2\x80\x94'
exclude=()

status=0
git grep -n -I -F --untracked -e "$emdash" -- . "${exclude[@]}" || status=$?
case $status in
  0) echo "em-dash (U+2014) found in the files above; remove it before publishing."; exit 1 ;;
  1) echo "no em-dash found" ;;
  # grep's 0/1 contract has a third answer; treating it as "no match" is how a
  # scrub gate passes without having read anything.
  *) echo "git grep failed (exit $status), so the scrub did not run." >&2; exit "$status" ;;
esac
