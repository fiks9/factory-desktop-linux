# Factory Theme-Aware Window Controls Design

## Goal

Make the Linux Electron window controls follow the theme selected inside Factory. Factory's `System` preference must continue to follow the operating-system theme.

## Architecture

Factory already exposes a constrained preload method, `window.electronAPI.window.setThemeSource`, and validates `system`, `light`, or `dark` in the main-process `window:setThemeSource` handler before assigning `nativeTheme.themeSource`. The Linux patch will reuse that contract instead of adding renderer IPC, polling the DOM, or reading user settings directly.

Each patched `BrowserWindow` starts with a `titleBarOverlay` derived from `nativeTheme.shouldUseDarkColors`. On Linux, a per-window `nativeTheme.updated` listener reapplies the overlay through `BrowserWindow.setTitleBarOverlay`. The listener is removed when the window closes, so additional Factory windows do not leak listeners.

## Visual Contract

- Light Factory theme: background `#f2f0f0`, symbols `#000000`.
- Dark Factory theme: background `#161413`, symbols `#f2f0f0`.
- Overlay height is 26 pixels, matching Factory 0.142.0's measured title strip instead of extending into the content surface.
- Colors use Factory 0.142.0's `surface-1` and `text-default` tokens.
- Electron retains the platform hover and close-button behavior.

## Safety And Drift

- The patch accepts only the existing Factory `nativeTheme` signal; it does not expose a new generic renderer-to-main API.
- The structural matcher must identify exactly one BrowserWindow constructor, its Electron alias, its window variable, and its `webContents` anchor.
- The validator requires exactly one marker, initial adaptive overlay, listener registration, listener cleanup, icon assignment, and no old static overlay.
- Any missing or duplicated anchor rejects the candidate fail-closed.
- Non-Linux platforms keep their current behavior.

## Testing

- A synthetic bundle proves light and dark overlay palettes are present.
- A runtime-style unit harness proves `nativeTheme.updated` changes the applied overlay.
- A cleanup assertion proves `closed` removes the listener.
- Existing idempotency and drift tests remain blocking.
- Full Node/Rust checks, package smoke, and package inspection run before local installation.
