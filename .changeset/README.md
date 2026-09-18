# Changesets

Version and publish `@assforge/cogent-sandbox` with the same tool as
dockyard, gitflow-packages, agent-slate, and agent-daemon.

1. After a user-facing change, run `npm run changeset` and commit the
   file it writes under this directory.
2. When shipping, run `npm run version` on `main`. That consumes pending
   files, bumps `package.json`, and prepends `CHANGELOG.md`.
3. Commit that bump, then `npm run release` (GitHub Packages, restricted).

Do not hand-edit `package.json` version. 0.22.1 and earlier were manual.
