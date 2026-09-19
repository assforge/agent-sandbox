# @assforge/cogent-sandbox

## 0.22.4

### Patch Changes

- 177256b: Close the sibling restore channel: a hand-edited backup whose root points
  at a refused path fails before any claim is written, restore canonicalizes
  exactly like registration so symlinked-home verdicts match, and the
  restore flow plus the mount-guard wording in the docs match the code.

## 0.22.3

### Patch Changes

- c2dfc05: Harden restore and mounts: backups carrying a refused mount fail before
  any claim is written, descendants of the sandbox state directory are
  refused like the directory itself, and workspace status lists windows
  through the terminal engine instead of a literal tmux call.

## 0.22.2

### Patch Changes

- bdd3e03: Close the independent review: registry writes go through short
  transactions, restore records a crash claim that freezes dependents,
  review-driven hardening across mount guard, agent catalog, herder
  errors, fingerprint drift, close race, backup layout, and doctor
  honesty, plus packaging that no longer ships local tool state.

Releases after 0.22.1 are produced by `npm run version` (changesets).
0.22.1 and earlier were versioned by editing `package.json`.
