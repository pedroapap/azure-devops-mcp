# Fork Sync

This document explains how to maintain this fork of
[microsoft/azure-devops-mcp](https://github.com/microsoft/azure-devops-mcp)
and keep it current with upstream while preserving fork-specific customizations.

## Fork Scope: On-Premises Support

This fork carries customizations for on-premises Azure DevOps Server support,
including Personal Access Token (PAT) authentication.

Quick usage example in `mcp.json`:

```json
{
   "servers": {
      "ado-onprem": {
         "type": "stdio",
         "command": "mcp-server-azuredevops",
         "args": ["${input:ado_org}", "--authentication", "pat"],
         "env": {
            "AZURE_DEVOPS_PAT": "your-pat-token",
            "SERVER_URL": "https://azuredevops.contoso.com"
         }
      }
   }
}
```

Keep these on-premises changes in `main-on-prem-support` so they survive each
upstream sync.

## Branch Roles

### `main`

The **published branch** of this fork. It is **rebuilt** each time you run the
sync script and must never be edited directly:

- **base**: `upstream/main` (the Microsoft repository)
- **plus**: commits from `main-on-prem-support` cherry-picked on top

> **Do not commit fork-specific changes directly to `main`.**
> They will be overwritten the next time `main` is rebuilt from upstream.

### `main-on-prem-support`

The **durable source** of all fork-specific customizations. Every change that
must survive upstream sync cycles — application logic, configuration, or
maintenance tooling — must be committed here.

When the sync script runs, it uses `git cherry` (patch-ID comparison) to
identify commits from `main-on-prem-support` that have not yet been applied to
`upstream/main`, then cherry-picks them on top of the latest upstream to produce
the new `main`.

## Upstream Remote

The upstream repository is `microsoft/azure-devops-mcp`:

```
git@github.com:microsoft/azure-devops-mcp.git
```

The sync script (`scripts/sync-fork.sh`) automatically configures or refreshes
the `upstream` remote each run. You do not need to set it up manually; you only
need a GitHub SSH key available in your environment.

> The script does **not** assume any particular local remote configuration, so it
> is safe to run in a fresh clone or a CI environment where only `origin` is
> initially defined.

## Adding Fork-Specific Changes

Always commit fork-only changes to `main-on-prem-support`:

```bash
git checkout main-on-prem-support
# edit files
git add <files>
git commit -m "description of fork-specific change"
git push origin main-on-prem-support
```

After pushing, run the sync script to rebuild `main`.

## Running the Sync Script

```bash
# From the repository root
./scripts/sync-fork.sh
```

The script will:

1. Verify the working tree is clean.
2. Configure or refresh the `upstream` remote.
3. Fetch `origin` and `upstream`.
4. Verify `origin/main-on-prem-support` exists.
5. Use `git cherry` to identify commits from `main-on-prem-support` not yet
   applied to `upstream/main` (patch-ID comparison, not SHA comparison — so
   commits already upstreamed with a different SHA are automatically skipped).
6. Create a temporary `main-rebuild` branch from `upstream/main`.
7. Cherry-pick each identified commit onto `main-rebuild`.
8. On success: make `main` point to the rebuilt HEAD and push to `origin` with
   `--force-with-lease`.
9. Delete the temporary `main-rebuild` branch.

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
>
> ```bash
> git cherry-pick --skip
> ```

## Recommended: Enable `rerere`

Git's `rerere` (reuse recorded resolution) feature remembers how you resolved a
conflict and can re-apply that resolution automatically in future syncs. This is
especially useful for a fork that is periodically rebased onto upstream.

Enable it for this repository only:

```bash
git config rerere.enabled true
```

Or globally on your machine (optional):

```bash
git config --global rerere.enabled true
```

Enabling `rerere` is strongly recommended but optional — the sync script works
without it. See the
[git-rerere documentation](https://git-scm.com/docs/git-rerere) for details.

## One-Time Setup Summary

```bash
# Clone your fork (replace <your-username> with your GitHub username)
git clone git@github.com:<your-username>/azure-devops-mcp.git
cd azure-devops-mcp

# (Recommended) enable rerere for this repo
git config rerere.enabled true

# Add fork-specific commits to main-on-prem-support
git checkout main-on-prem-support
# ... make changes, commit, push ...

# Sync with upstream and rebuild main
./scripts/sync-fork.sh
```
