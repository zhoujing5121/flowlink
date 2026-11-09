# Changelog

All notable changes to FlowLink will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) principles and this project uses semantic versioning.

## [Unreleased]

### Added

- **Recording:** Replay the required flow prefix before re-recording or inserting a process node, then preserve the resulting browser state and active tab.
- Repository documentation for English and Chinese users, architecture, contribution, agent development, and changelog maintenance.
- Windows Electron/Playwright application build and packaging workflow.
- Flow recording, replay, task persistence, element evidence, screenshots, dialogs, downloads, tabs, and iframe/frame support.

### Changed

- None yet.

### Fixed

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
