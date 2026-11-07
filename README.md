# FlowLink

FlowLink is a Windows desktop application for recording browser workflows, storing them as structured action traces, and replaying them with Playwright. It combines an Electron user interface with a local recorder/executor engine and can attach to embedded web views through Chrome DevTools Protocol (CDP).

## Features

- Record browser actions inside the Electron app
- Create task profiles and keep multiple recordings per task
- Replay flows with ordered steps, assertions, variables, and waits
- Capture element evidence, screenshots, dialogs, downloads, and frame/tab context
- Resolve elements through multiple candidates and stable fingerprints
- Re-record flows and review execution artifacts
- Persist tasks and recordings in the Electron user-data directory
- Package the application as a Windows x64 ZIP

## Requirements

- Windows x64
- Node.js 20 or newer
- npm
- Electron and Playwright dependencies installed from `package-lock.json`

## Install and run

```powershell
npm install
npm run start
```

Development mode opens Electron DevTools:

```powershell
npm run dev
```

The build command generates:

- `dist/main.js` and `dist/main.js.map`
- `dist/preload.cjs` and `dist/preload.cjs.map`

The recorder loads its capture script from `engine/recorder/capture/capture.js`.

```powershell
npm run build
```

## Package for Windows

```powershell
npm run package
```

The package script uses `electron-packager`, then creates:

- `release\FlowLink-win32-x64\`
- `release\FlowLink-Windows-x64.zip`

## Quick workflow

1. Create or select a task.
2. Enter an HTTP or HTTPS start URL.
3. Start recording.
4. Perform browser actions.
5. Stop recording to save the flow and artifacts.
6. Run the recording to replay it in the embedded browser.
7. Inspect screenshots, step results, downloads, and execution logs.

## Project layout

```text
src/                    Electron main process and preload bridge
renderer/               Desktop UI and renderer-side IPC integration
engine/
  schema/               Flow JSON schema, migration, parsing, and validation
  recorder/             Capture, event coalescing, planning, and profile handling
  resolver/             Element candidate and frame resolution
  executor/             Replay, self-healing, artifacts, tabs, dialogs, and downloads
capture/                Built capture script copied during build
release/                Existing package output
dist/                   Generated build output
```

See [Architecture](docs/architecture.md), [Contributing](CONTRIBUTING.md), and [Agent Instructions](AGENTS.md).

## Generated data

Electron user data is used for persistent application state:

```text
<userData>\flowlink\tasks.json
<userData>\flowlink\flows\*.json
<userData>\flowlink\artifacts\<flowId>\...
```

Flow artifacts use absolute paths in task metadata, while flow files retain relative artifact references where supported. Replay artifacts are stored under:

```text
artifacts\<flowId>\runs\<runId>\
  result.json
  <stepIndex>\before.png
  <stepIndex>\after.png
  <stepIndex>\snapshot.json
  <stepIndex>\log.txt
```

## Security notes

- The preload script exposes only a small `window.flowlink` API to the renderer.
- Navigation is limited to HTTP and HTTPS URLs.
- Password values in recorded flow steps must be represented as `{{variable}}` templates.
- Storage-state files contain cookies and local storage credentials; treat them as secrets and do not commit them.
- Artifact and download path helpers sanitize generated path segments.
- External navigation requested by embedded pages is redirected into the embedded browser.

## Status and scope

The repository currently has no project-owned automated test suite or lint script. Validation is provided by the strict build and Zod flow validation. Before completing a change, run at least `npm run build` and add targeted tests when introducing a test runner.
