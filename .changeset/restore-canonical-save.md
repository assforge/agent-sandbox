---
'@assforge/cogent-sandbox': patch
---

Restore stores the vetted canonical root and mounts instead of the
manifest spelling, so a symlink swapped between restore and start cannot
redirect the next bind, and a refused backup path exits 2 like the
registration refusal it mirrors.
