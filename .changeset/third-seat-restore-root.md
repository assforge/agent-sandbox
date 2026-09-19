---
'@assforge/cogent-sandbox': patch
---

Close the sibling restore channel: a hand-edited backup whose root points
at a refused path fails before any claim is written, restore canonicalizes
exactly like registration so symlinked-home verdicts match, and the
restore flow plus the mount-guard wording in the docs match the code.
