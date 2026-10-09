#!/usr/bin/env bash
# In-app update for this fork (set as CLOUDCLI_UPDATE_COMMAND): merge the
# latest upstream CloudCLI release into the current, customised branch,
# install dependencies, rebuild, and push the branch. A merge that conflicts
# with the customisations is backed out and reported instead.
set -euo pipefail
cd "$(dirname "$0")/.."

branch="$(git rev-parse --abbrev-ref HEAD)"
git remote get-url upstream >/dev/null 2>&1 \
  || git remote add upstream https://github.com/siteboon/claudecodeui.git

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Uncommitted changes on $branch; commit them before updating." >&2
  exit 1
fi

echo "Fetching upstream CloudCLI..."
git fetch upstream
if git merge-base --is-ancestor upstream/main HEAD; then
  echo "$branch already contains the latest upstream release."
else
  echo "Merging upstream/main into $branch..."
  if ! git merge --no-edit upstream/main; then
    git merge --abort
    echo "Upstream changes conflict with the customisations on $branch; this merge needs a hand." >&2
    exit 1
  fi
fi

npm install
npm run build
git push origin "$branch" || echo "warning: could not push $branch to origin" >&2
echo "Updated $branch to $(git log --oneline -1)"
