# Changelog

All notable changes to FlowLink will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) principles and this project uses semantic versioning.

## [Unreleased]

### Added

- **UI:** Restore saved recordings into the Design tab after app restart.
- **UI:** Refine side pane with three mock options that dispatch to the existing merge flow.
- **UI:** "Auto" badge on every step in Process, Instruction, and Test views.
- **UI:** Sidebar "Automation rate -%" indicator with a light blue background.
- **Recording:** Replay the required flow prefix before re-recording or inserting a process node, then preserve the resulting browser state and active tab.
- Repository documentation for English and Chinese users, architecture, contribution, agent development, and changelog maintenance.
- Windows Electron/Playwright application build and packaging workflow.
- Flow recording, replay, task persistence, element evidence, screenshots, dialogs, downloads, tabs, and iframe/frame support.

### Changed

- None yet.

### Fixed

- **Startup:** Load task-list metadata and recording counts first, then defer recording metadata and saved Flow detail hydration until its task drawer opens.
- **Pi:** Run SDK initialization and provider prompts in a worker thread so slow provider/proxy requests do not block the Electron main process.
- **AI:** Scroll recording context and conversation together, and retain chat history when the assistant pane is reopened.
- **Pi:** Load provider/model settings, apply the SDK system prompt with all tools disabled, and preserve provider errors instead of reporting only an empty response.
- **Startup:** Show the FlowLink window without waiting for the initial browser page's network response.
- **Pi:** Defer SDK loading until Pi is used and honor environment-configured HTTP proxies for provider requests.
- **Replay:** Create new tabs through native Electron views instead of unsupported CDP `Target.createTarget` calls.
- **Test:** Reset to one fresh browser on every Test entry and await recording cleanup before restarting.
- **Recording:** Avoid native-view loading flashes and unnecessary browser chrome/dock recreation.
- **UI:** Keep workspace confirmations visible above the native browser and reserve space for the floating AI dock in every Design state.
- **Recording:** Persist native tab creation and its first navigation as one replayable `openTab` action.
- **Recording:** Cancel empty or still-starting recordings cleanly without blocking Stop or creating empty records and capture artifacts.
- **UI:** Wrap long Process URLs and require one confirmation for profile Save and drawer Close actions.
- **Development:** Launch Windows terminals with UTF-8 input/output so Chinese logs remain readable.

### Security

- Storage-state handling preserves raw or wrapped profile shapes and treats credentials as sensitive data.
