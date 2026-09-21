# @assforge/cogent-sandbox

## 0.30.1

### Patch Changes

- 65c6e28: Close final-review findings: drift walks every catalog engine
  (recorded-but-gone warns), instance names validated at the registry
  load boundary, and doc/help leftovers fixed.

## 0.30.0

### Minor Changes

- 2385c29: Add Aider and Goose as native agent engines: catalog entries (pip
  floor plus standalone script), container installs, sixteen-command
  version probe, fork seeding, and doctor drift coverage. Aider needs
  API keys (no subscription login); goose configure step is skipped
  headless.

## 0.29.0

### Minor Changes

- 5333f34: Keyed version probe: every binary reports as key=value so missing,
  extra, or multi-line outputs can never misattribute versions; unknown
  keys are dropped against the engine set. Upgrade reports unresolvable
  latest versions honestly instead of claiming current, and rebuilds
  when the recording predates an engine.

## 0.28.1

### Patch Changes

- d852c8e: Close final-review findings: workspace upgrade rebuilds when the
  recording predates an engine, doctor reports image-absent engines,
  cursor version parsing tolerates its binary prefix, registry
  validation tightened, and leftover doc contradictions fixed.

## 0.28.0

### Minor Changes

- 1e9e94a: Add Cursor, Devin and Kiro as native agent engines: catalog entries,
  container installs (latest-only scripts into HOME-scoped paths),
  fourteen-command version probe, fork seeding, and doctor drift
  coverage. Cursor launches with --disable-auto-update baked in;
  Devin's setup-wizard installer tail is tolerated by binary-existence
  check.

## 0.27.0

### Minor Changes

- 76a63b7: Add Qwen, Kimi, Mimo and Auggie as npm agent engines: catalog
  entries, container installs, eleven-command version probe, fork
  seeding, and doctor drift coverage. DeepSeek has no official CLI
  (its models already work through pi, opencode and aider); Cursor
  stays out (calver versions fail the floor gate, self-updates by
  default); Kiro stays out (latest-only plus social-login-only).

## 0.26.0

### Minor Changes

- 75e7561: Add Grok and Agy as native agent engines: catalog entries, container
  installs (version-addressable script for grok, latest-only script for
  agy), seven-command version probe, fork seeding, and doctor drift
  coverage. Kiro stays out: latest-only script plus social-login-only
  auth does not fit the container model.

## 0.25.0

### Minor Changes

- 5e3f3cd: Latest-first version strategy: images install whatever the channels
  currently serve instead of frozen pins. Catalog versions are floors,
  the build gate demands every binary report at or above its floor, the
  resolved set prints as the build receipt and records on the registry
  entry at activation, and doctor compares the running container against
  that recording (falling back to the floor without one).

### Patch Changes

- 5e3f3cd: `image list` shows unreferenced local images with the prune hint, in
  text and JSON. `workspace.ts` splits into lifecycle/instances/config/
  state modules; no behaviour change.

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
