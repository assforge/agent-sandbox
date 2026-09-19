# @assforge/cogent-sandbox

## 0.24.1

### Patch Changes

- 560018e: Split the 1873-line CLI entry into resource-group modules under
  `src/commands/` behind a thin dispatch. No behaviour change: help
  output is byte-identical and the suite passes untouched, except the
  registry-write invariant test which now covers the whole command
  layer.

## 0.24.0

### Minor Changes

- 308b3e8: Add `image prune`: remove workspace images no workspace references
  (current plus previous are kept) across every runtime in use, after
  confirmation.

### Patch Changes

- 308b3e8: Doctor warns when project hooks or MCP servers reference commands
  missing inside the running container, instead of failing obscurely
  mid-session.

## 0.23.1

### Patch Changes

- 7976d52: Finish the Pi wiring the review caught: entrypoint and image home
  shape include `.pi`, docs count five engines everywhere, and the probe
  parser documents its fail-closed misalignment property.

## 0.23.0

### Minor Changes

- 7f32357: Add Pi (`@earendil-works/pi-coding-agent@0.85.1`) as the fifth agent
  engine: catalog entry, container install, version probe, fork seeding,
  and doctor drift coverage. Also filter copilot 1.0.86's stdout update
  hint in the version probe so the positional parse keeps working.

## 0.22.6

### Patch Changes

- da44915: Track upstream agent releases: codex 0.154.0 to 0.155.1, copilot 1.0.85
  to 1.0.86. Both verified for unchanged `--version` output shape in a
  Linux container before the pins moved.

## 0.22.5

### Patch Changes

- 32e39dc: Restore stores the vetted canonical root and mounts instead of the
  manifest spelling, so a symlink swapped between restore and start cannot
  redirect the next bind, and a refused backup path exits 2 like the
  registration refusal it mirrors.

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
