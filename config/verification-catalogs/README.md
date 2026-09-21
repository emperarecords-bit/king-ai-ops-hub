# Verification command catalogs (VER-002)

Trusted, version-controlled catalogs that map a verification **check name** to the exact **command**
that satisfies it. They are resolved SERVER-SIDE only — a runner or any caller can never supply
catalog contents or an authoritative digest.

- `versions/<version>.json` — an **immutable** catalog snapshot. Once committed, a version file is
  never edited; a change is a **new version file** reviewed in its own PR. This preserves old
  versions so contracts pinned to them stay verifiable after the catalog moves on.
- `current.json` — `{ "default": "<version>", "projects": { "<projectId>": "<version>" } }`: the
  trusted pointer to the version a NEW contract pins, per project (falling back to `default`).
  Changing a pointer is a reviewed PR; it never rewrites history.

Format of a version file:

```json
{ "version": "<version>", "checks": { "<name>": { "command": "<exact command>" } } }
```

The catalog **digest** is `SHA-256` over the *canonical JSON* (recursively sorted keys) of the parsed
version object — not the raw bytes — so reformatting cannot change identity. A contract pins the
`(version, digest)` resolved at creation; ingestion re-resolves the pinned version server-side and
fails **closed** if it is missing or its digest no longer matches.
