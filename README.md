# Claude Tower

See every Claude Code session on your Mac at a glance — which ones are working, which need your
approval or have a question, and which just finished — without cycling through terminal tabs.

Two parts, one repo:

| Part | What you get |
| --- | --- |
| **Menu bar app** (`menubar/`) | `✳ 2  ✻ 1` in the menu bar: sessions working, sessions that need you. Click for the list; click a session to jump to its tab. A banner when one needs you or finishes. |
| **Claude Code plugin** (`plugin/`, id `session-tower`) | Every session reports its state. Optionally draws a **deck** — one card per session — above the prompt, plus a `/tab <project or ticket>` command to jump between sessions. |

The plugin is what feeds the menu bar app, so install both. The deck is optional (see Settings).

## Requirements

- macOS 14.4+, Apple Silicon or Intel
- Xcode command line tools (`xcode-select --install`)
- A Claude Code build with plugin hooks modules (2.1.289 or later is known to work)

## Install

```bash
git clone <this repo> ~/projects/claude-tower
cd ~/projects/claude-tower

# 1. The plugin
claude plugin marketplace add "$PWD"
claude plugin install session-tower@session-tower

# 2. The menu bar app, started at login
./menubar/build.sh --login
```

Restart open Claude sessions (or run `/reload-plugins`) so they start reporting.

The first time you click a session, macOS asks to let Claude Tower control Terminal (or iTerm2) —
allow it, or clicks just bring the terminal forward.

## Settings

**Deck on or off** — in Claude Code, `/config` → *Show the session deck above the prompt*
(`session-tower.deck`), or `/plugin configure session-tower@session-tower`. Off keeps the terminal
clean (no deck, no in-terminal toasts); sessions still report to the menu bar app.

**Finish notifications** — menu bar → *Notify when a session finishes*. Needs-you alerts are always on.

## Update

```bash
git pull
./menubar/build.sh        # only when menubar/ changed
```

then `/reload-plugins` in open sessions. The plugin is read from this folder, so no reinstall.

## Uninstall

```bash
./menubar/build.sh --unlogin && rm -rf ~/Applications/"Claude Tower.app"
claude plugin uninstall session-tower@session-tower
claude plugin marketplace remove session-tower
```

## Good to know

- **Terminals.** Click-to-jump selects the exact tab in Terminal.app and iTerm2. Ghostty, Warp and
  others are brought forward, but the tab isn't selected.
- **Titles cost a little.** Each session asks Haiku for a 2–5 word title after your prompts, so the
  menu reads "Fix Login Redirect" rather than the folder name.
- **Notifications.** The app is ad-hoc signed, which Notification Center refuses, so it shows its own
  banner in the top-right corner instead.
- **Logs.** `~/Library/Logs/ClaudeTower.log`.

## How it works

```
Claude session ─┐  session-tower plugin: state, task, step, subagents, shells
Claude session ─┼─► shared plugin store ─► deck above each prompt (optional)
Claude session ─┘                     └──► ~/.claude/claude-tower-status.json ─► menu bar app
```

Each session heartbeats every 3 s; one that stops for 15 s (crash, closed tab) drops off everywhere.

## Develop

```bash
claude plugin validate plugin
claude plugin test plugin
```
