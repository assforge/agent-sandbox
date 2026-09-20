---
'@assforge/cogent-sandbox': minor
---

Keyed version probe: every binary reports as key=value so missing,
extra, or multi-line outputs can never misattribute versions; unknown
keys are dropped against the engine set. Upgrade reports unresolvable
latest versions honestly instead of claiming current, and rebuilds
when the recording predates an engine.
