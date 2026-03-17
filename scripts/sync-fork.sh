#!/usr/bin/env bash
# sync-fork.sh  -  Rebuild origin/main as upstream/main + main-on-prem-support commits.
#
# Usage:
#   ./scripts/sync-fork.sh
#
# Requirements:
#   - Run from the root of a clone of this fork.
#   - Working tree must be clean (no uncommitted changes).
#   - SSH key for github.com must be available (used by the upstream remote).
#
# See docs/fork-sync.md for full documentation.

set -euo pipefail

BRANCH_MAIN="main"
BRANCH_CUSTOM="main-on-prem-support"
REMOTE_UPSTREAM="upstream"
REMOTE_ORIGIN="origin"
UPSTREAM_URL="git@github.com:microsoft/azure-devops-mcp.git"
REBUILD_BRANCH="${BRANCH_MAIN}-rebuild"

# --------------------------------------------------------------------------
# 1. Require clean working tree
# --------------------------------------------------------------------------
DIRTY=false
git diff --quiet || DIRTY=true
git diff --cached --quiet || DIRTY=true
if $DIRTY; then
  echo "error: working tree is dirty - commit or stash your changes first." >&2
  exit 1
fi

# --------------------------------------------------------------------------
# 2. Configure or refresh the upstream remote
# --------------------------------------------------------------------------
if git remote get-url "$REMOTE_UPSTREAM" &>/dev/null; then
  CURRENT_URL=$(git remote get-url "$REMOTE_UPSTREAM")
  if [ "$CURRENT_URL" != "$UPSTREAM_URL" ]; then
    echo "Updating $REMOTE_UPSTREAM remote -> $UPSTREAM_URL"
    git remote set-url "$REMOTE_UPSTREAM" "$UPSTREAM_URL"
  fi
else
  echo "Adding $REMOTE_UPSTREAM remote: $UPSTREAM_URL"
  git remote add "$REMOTE_UPSTREAM" "$UPSTREAM_URL"
fi

# --------------------------------------------------------------------------
# 3. Fetch both remotes
# --------------------------------------------------------------------------
echo "Fetching $REMOTE_ORIGIN..."
git fetch "$REMOTE_ORIGIN" --prune

echo "Fetching $REMOTE_UPSTREAM..."
git fetch "$REMOTE_UPSTREAM" --prune

# --------------------------------------------------------------------------
# 4. Resolve the custom branch ref from the remote (does not touch local branch)
# --------------------------------------------------------------------------
CUSTOM_REF="$REMOTE_ORIGIN/$BRANCH_CUSTOM"
if ! git rev-parse --verify "$CUSTOM_REF" &>/dev/null; then
  echo "error: branch '$BRANCH_CUSTOM' not found on $REMOTE_ORIGIN." >&2
  echo "       Push it first: git push $REMOTE_ORIGIN $BRANCH_CUSTOM" >&2
  exit 1
fi

UPSTREAM_MAIN="$REMOTE_UPSTREAM/$BRANCH_MAIN"

# --------------------------------------------------------------------------
# 5. Compute custom commits not yet merged into upstream/main
# --------------------------------------------------------------------------
COMMITS=$(git rev-list --reverse "${UPSTREAM_MAIN}..${CUSTOM_REF}")
COMMIT_COUNT=0
if [ -n "$COMMITS" ]; then
  COMMIT_COUNT=$(echo "$COMMITS" | wc -l | tr -d ' ')
fi

# --------------------------------------------------------------------------
# 6. Create a clean rebuild branch from upstream/main
# --------------------------------------------------------------------------
echo
echo "Rebuilding '$REBUILD_BRANCH' from $UPSTREAM_MAIN..."
git checkout -B "$REBUILD_BRANCH" "$UPSTREAM_MAIN"

# --------------------------------------------------------------------------
# 7. Cherry-pick each custom commit
# --------------------------------------------------------------------------
if [ "$COMMIT_COUNT" -eq 0 ]; then
  echo "No custom commits to apply - main will match upstream/main exactly."
else
  echo "Applying $COMMIT_COUNT custom commit(s) from $BRANCH_CUSTOM..."
  for COMMIT in $COMMITS; do
    SUMMARY=$(git log --oneline -1 "$COMMIT")
    echo "  + $SUMMARY"
    git cherry-pick "$COMMIT" || {
      echo
      echo "========================================================"
      echo "  CONFLICT while applying:"
      echo "    $SUMMARY"
      echo "========================================================"
      echo
      echo "  Steps to resolve:"
      echo "    1. Fix conflict markers in each conflicted file."
      echo "    2. Stage the resolved files:"
      echo "         git add <resolved-file> ..."
      echo "    3. Continue the cherry-pick:"
      echo "         git cherry-pick --continue"
      echo "       (Repeat for any further conflicting commits.)"
      echo
      echo "  To skip this specific commit instead:"
      echo "         git cherry-pick --skip"
      echo
      echo "  After all cherry-picks finish, complete the sync:"
      echo "         git checkout $BRANCH_MAIN"
      echo "         git reset --hard $REBUILD_BRANCH"
      echo "         git push $REMOTE_ORIGIN $BRANCH_MAIN --force-with-lease"
      echo
      exit 1
    }
  done
fi

# --------------------------------------------------------------------------
# 8. Update main to the rebuilt HEAD and push
# --------------------------------------------------------------------------
echo
echo "Updating '$BRANCH_MAIN' and pushing to $REMOTE_ORIGIN..."
git checkout -B "$BRANCH_MAIN" HEAD
git push "$REMOTE_ORIGIN" "$BRANCH_MAIN" --force-with-lease

# --------------------------------------------------------------------------
# 9. Clean up the temporary rebuild branch
# --------------------------------------------------------------------------
git branch -D "$REBUILD_BRANCH" 2>/dev/null || true

echo
echo "Done. '$BRANCH_MAIN' = upstream/main + $COMMIT_COUNT custom commit(s)."
