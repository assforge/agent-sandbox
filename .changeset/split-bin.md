---
'@assforge/cogent-sandbox': patch
---

Split the 1873-line CLI entry into resource-group modules under
`src/commands/` behind a thin dispatch. No behaviour change: help
output is byte-identical and the suite passes untouched, except the
registry-write invariant test which now covers the whole command
layer.
