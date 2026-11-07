# Contributing

## Setup

```powershell
npm install
npm run start
```

Use Node.js 20 or newer. Preserve the Windows-specific packaging assumptions unless adding cross-platform support deliberately.

## Before changing code

1. Read the relevant architecture document and public entry point.
2. Preserve the separation between immutable recorder observations and replay/self-heal mutations.
3. Keep the Electron preload surface narrow.
4. Validate flow JSON through `parseFlow` or `saveFlow`; do not write flow files manually.
5. Never log secrets, passwords, cookies, or storage-state contents.

## Development commands

```powershell
npm run build
npm run dev
npm start
npm run package
```

There is currently no project-owned lint, type-check, or test script. `npm run build` bundles the main and preload processes. Use `npx tsc --noEmit` only when checking source types outside the build.

## Change checklist

- Run `npm run build`.
- Exercise recording start, stop, and navigation if browser code changed.
- Exercise replay success and failure if executor code changed.
- Load and save a representative flow if schema code changed.
- Verify artifact paths remain inside their expected directories.
- Check that password and storage-state values remain masked or secret.
- Update relevant documentation and the changelog.

## Style

- Use TypeScript strict-mode types; avoid `any`.
- Follow existing single-repository module patterns.
- Use focused helpers rather than duplicating path, template, and validation logic.
- Keep comments for non-obvious invariants only.
- Preserve existing API exports unless a migration is explicit.

## Pull requests

Include:

- A summary of the behavior change
- Files or subsystems affected
- Validation performed
- Any migration, packaging, or data-format impact
- Screenshots for meaningful UI changes
