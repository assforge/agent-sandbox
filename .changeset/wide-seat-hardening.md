---
'@assforge/cogent-sandbox': patch
---

Harden restore and mounts: backups carrying a refused mount fail before
any claim is written, descendants of the sandbox state directory are
refused like the directory itself, and workspace status lists windows
through the terminal engine instead of a literal tmux call.
