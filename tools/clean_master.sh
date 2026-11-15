#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# clean_master.sh - reduce the `master` branch to the introduction + licence.
#
# `master` still carries the whole old ZeroScript tree. After the move to
# `v0.1.0-dev` it should only keep the introduction and the licence, so anyone
# landing on the repository does not clone a stale copy of the old product.
#
# This script is MANUAL on purpose: nothing in this repository pushes on its
# own, and it rewrites `master`, so it asks before doing anything.
#
# What it keeps on master (taken from the CURRENT branch, not from old master):
#   README.md  README.zh-CN.md  LICENSE  NOTICE
#
# It builds a parentless ("orphan") commit with git plumbing, so your working
# tree, your branch and your index are never touched.
#
# Usage:
#   tools/clean_master.sh                    # show the plan, change nothing
#   tools/clean_master.sh --no-push          # build the commit locally (test run)
#   tools/clean_master.sh --yes              # rewrite origin/master (force push)

set -euo pipefail

KEEP="README.md README.zh-CN.md LICENSE NOTICE"
BRANCH="master"
REMOTE="origin"
YES=0
NO_PUSH=0

for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=1 ;;
    --no-push) NO_PUSH=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

ORIG="$(git rev-parse --show-toplevel)"
cd "$ORIG"

if [ -n "$(git status --porcelain)" ]; then
  echo "refusing to run: the working tree is not clean." >&2
  echo "commit or stash your changes first (git status)." >&2
  exit 1
fi

git fetch --quiet "$REMOTE" "$BRANCH"
old_sha="$(git rev-parse "$REMOTE/$BRANCH")"
DEV_SHA="$(git rev-parse HEAD)"

echo "rewrite:  $REMOTE/$BRANCH = $old_sha"
echo "content:  current HEAD   = $DEV_SHA"
echo "keeping:  $KEEP"
echo

if [ "$YES" -eq 0 ]; then
  echo "DRY RUN - nothing was changed."
  echo "Everything else would be removed from $BRANCH and the branch rewritten."
  echo
  echo "Re-run with:"
  echo "  tools/clean_master.sh --no-push   # build the commit locally, no push"
  echo "  tools/clean_master.sh --yes       # rewrite $REMOTE/$BRANCH"
  exit 0
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/nzs-master.XXXXXX")"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

# Build the tree in an isolated index: the repository index is untouched.
export GIT_INDEX_FILE="$tmp/index"
git read-tree --empty
git --work-tree="$tmp" checkout "$DEV_SHA" -- $KEEP 2>/dev/null || {
  echo "could not read the files from HEAD: $KEEP" >&2
  exit 1
}
tree="$(git write-tree)"

echo "New master tree:"
git ls-tree -r --name-only "$tree" | sed 's/^/  /'
echo

files="$(git ls-tree -r --name-only "$tree" | wc -l | tr -d ' ')"
if [ "$files" -eq 0 ]; then
  echo "refusing to push an empty branch" >&2
  exit 1
fi

export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-NonZeroScript}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-noreply@localhost}"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

commit="$(git commit-tree "$tree" -m "master: keep only the introduction and the licence

The product lives on v0.1.0-dev; master is now a landing page that points at
it. Removed the old ZeroScript tree (bridge, Roblox extension, config).

Previous master: $old_sha
Content taken from: $DEV_SHA")"

unset GIT_INDEX_FILE
echo "commit:   $commit"

if [ "$NO_PUSH" -eq 1 ]; then
  echo
  echo "Built the commit but did not push (--no-push)."
  echo "To publish it:  git push --force $REMOTE $commit:refs/heads/$BRANCH"
  exit 0
fi

echo
echo "Force-pushing to $REMOTE/$BRANCH ..."
if ! git push --force "$REMOTE" "$commit:refs/heads/$BRANCH"; then
  cat >&2 <<'HINT'

The push was rejected. `master` is usually the default branch, so GitHub may
refuse a force push:
  * Settings -> Branches -> allow force pushes for the default branch, or
  * Settings -> Branches -> switch the default branch to v0.1.0-dev, then re-run.
Nothing was lost: the new commit is local, and the old master SHA is printed
above (it also stays in the reflog).
HINT
  exit 1
fi

echo
echo "Done. $REMOTE/$BRANCH now contains only: $KEEP"
echo "Previous master ($old_sha) remains in the reflog and in the fork network."
