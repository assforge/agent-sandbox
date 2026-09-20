---
'@assforge/cogent-sandbox': minor
---

Latest-first version strategy: images install whatever the channels
currently serve instead of frozen pins. Catalog versions are floors,
the build gate demands every binary report at or above its floor, the
resolved set prints as the build receipt and records on the registry
entry at activation, and doctor compares the running container against
that recording (falling back to the floor without one).
