# Fork Sync

This document explains how to maintain this fork of
[microsoft/azure-devops-mcp](https://github.com/microsoft/azure-devops-mcp)
and keep it in sync with upstream while preserving fork-specific customizations.

## Branch Roles

### `main`

The published branch of this fork. It is **rebuilt automatically** each time you
run the sync script:

- base: `upstream/main` (the Microsoft repository)
- plus: commits from `main-on-prem-support` cherry-picked on top

> **Do not commit fork-specific changes directly to `main`.**
> They will be overwritten the next time `main` is rebuilt from upstream.

### `main-on-prem-support`

The durable source of all fork-specific customizations. Every change that must
survive upstream sync cycles must be committed here. When the sync script runs,
it cherry-picks all commits from this branch that are not yet in `upstream/main`
and applies them on top of the latest upstream to produce the new `main`.

## Upstream Remote

The upstream repository is `microsoft/azure-devops-mcp`:

```
git@github.com:microsoft/azure-devops-mcp.git
```

The sync script (`scripts/sync-fork.sh`) automatically configures or refreshes
the `upstream` remote. You do not need to set it up manually; you only need a
GitHub SSH key available in your environment.

## Adding Fork-Specific Changes

Always commit fork-only changes to `main-on-prem-support`:

```bash
git checkout main-on-prem-support
# edit files
git add <files>
git commit -m "description of fork-specific change"
git push origin main-on-prem-support
```

After committing, run the sync script to rebuild `main`.

## Running the Sync Script

```bash
# From the repository root
./scripts/sync-fork.sh
```

The script will:

1. Verify the working tree is clean.
2. Configure or refresh the `upstream` remote.
3. Fetch `origin` and `upstream`.
4. Create a temporary `main-rebuild` branch from `upstream/main`.
5. Cherry-pick every commit from `main-on-prem-support` that is not yet in
   `upstream/main`.
6. On success: reset `main` to the rebuilt result and push to `origin` with
   `--force-with-lease`.

## Recovering from Conflicts

If a cherry-pick conflict occurs, the script stops and prints exact next steps.
The general recovery flow is:

1. Fix the conflict markers in each conflicted file.
2. Stage the resolved files:
   ```bash
   git add <resolved-file> ...
   ```
3. Continue the cherry-pick sequence:
   ```bash
   git cherry-pick --continue
   ```
   Repeat steps 1–3 for each further conflicting commit.
4. Once all cherry-picks finish, complete the sync:
   ```bash
   git checkout main
   git reset --hard main-rebuild
   git push origin main --force-with-lease
   ```

> **Tip:** To skip a specific commit instead of resolving it:
> ```bash
> git cherry-pick --skip
> ```

## Recommended: Enable `rerere`

Git's `rerere` (reuse recorded resolution) feature remembers how you resolved a
conflict and can re-apply that resolution automatically in future syncs. This is
especially useful for a fork that is periodically rebased onto upstream.

Enable it for this repository:

```bash
git config rerere.enabled true
```

Or globally on your machine:

```bash
git config --global rerere.enabled true
```

See the [git-rerere documentation](https://git-scm.com/docs/git-rerere) for
details. Enabling it is strongly recommended but not required for the sync
script to work.

## One-Time Setup Summary

```bash
# Clone your fork (replace with your fork URL)
git clone git@github.com:<your-user>/azure-devops-mcp.git
cd azure-devops-mcp

# (Optional but recommended) enable rerere
git config rerere.enabled true

# Add your fork-specific commits to main-on-prem-support
git checkout main-on-prem-support
# ... make changes, commit, push ...

# Sync with upstream
./scripts/sync-fork.sh
```
