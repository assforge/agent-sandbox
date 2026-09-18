# @assforge/cogent-sandbox — Agent Guidelines

Sandboxed multi-agent workbench: workspace environments and agent processes
over Docker containers and host tmux sessions. Npm package
`@assforge/cogent-sandbox`, executable `sandbox`, repository
`assforge/agent-sandbox`.

## Source layout

- `src/` — library source (compiled to `dist/`)
- `src/bin/sandbox.ts` — CLI entry (help and version work without Docker, tmux, or registry)
- `tests/` — Vitest unit tests (isolated prefixes, temp dirs, labeled resources)
- `templates/` — workspace image Dockerfile and entrypoint
- `dist/` — compiled output (gitignored)

## Design constraints

- All help, diagnostics, prompts and errors are English. ASCII status markers, no arrow glyphs.
- Registry files are data, never shell-sourced, never mounted into containers.
- No shell string evaluation of user input: execution uses argv vectors.
- Provider secrets are never accepted as wrapper CLI arguments.
- Doctor is read-only and never installs anything automatically.
- No test may touch the `pedantic_snyder` container or `claude-relay-config` volume.
- No paid provider prompt is required for generic lifecycle tests.
- Version and publish through changesets (`npm run changeset` / `version` / `release`). Do not hand-edit `package.json` version.

See `.agent.workspace/tasks/254_cogent_sandbox_cli/architecture.md` in the
microsb governance workspace for the frozen design.
