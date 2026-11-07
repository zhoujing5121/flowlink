# Changelog Guide

FlowLink uses `CHANGELOG.md` in Keep a Changelog style and Semantic Versioning.

## Required workflow

Every user-visible change should add an entry under the next version or under `Unreleased`.

1. Add entries under exactly the relevant headings:
   - `Added`
   - `Changed`
   - `Fixed`
   - `Deprecated`
   - `Removed`
   - `Security`
2. Write one concise sentence per entry.
3. Lead with the user-visible outcome, not implementation details.
4. Name the affected flow, recorder, executor, UI, packaging, or storage area.
5. Mention migration or compatibility steps when required.
6. Do not expose secrets, credentials, URLs containing tokens, or private customer data.

## Entry format

```markdown
- **Recording:** Describe the behavior users now have.
- **Executor:** Fix element resolution during iframe navigation.
- **Packaging:** Include the required native DLL in Windows ZIP builds.
```

## Releasing

When creating a release:

1. Move all `Unreleased` entries into a version section.
2. Use the format:

```markdown
## [0.2.0] - 2026-11-06
```

3. Update the package version in `package.json` and `package-lock.json`.
4. Verify `npm run build` and `npm run package` before release.
5. Keep a link to the version compare or commit range when repository hosting is added.
6. Add a `Security` entry for any user-impacting security fix.

## Change classification

- `Added`: new capability or API
- `Changed`: existing behavior changed
- `Fixed`: bug or regression corrected
- `Deprecated`: scheduled removal announced
- `Removed`: publicly supported behavior/API removed
- `Security`: confidentiality, integrity, or credential-handling change

## Do not

- Do not rewrite older release history.
- Do not use vague entries such as “fixed bugs”.
- Do not put implementation-only refactors under `Changed` unless they affect users.
- Do not generate changelog entries from dependency lockfile noise unless behavior or security changed.
