# Zen Tree Style Tabs

Automatic tree hierarchy for unpinned tabs in Zen Browser's vertical sidebar. Tabs nest
under the tab they were opened from, with collapse/expand and close-subtree.

Verified working on **Zen 1.21.11b** (Firefox 152), macOS 26.3, Apple Silicon.

## Why this isn't a normal Zen Mod

Official Zen Mods are CSS + `preferences.json` only. CSS can't read `openerTab` or
reparent DOM nodes, so a tree is impossible in that format. This ships as a
[Sine](https://github.com/CosmoCreeper/Sine) mod instead, which loads chrome-level
JavaScript into `browser.xhtml`.

## Install

### 1. Install Sine

Grab the installer for your platform from
[Sine releases](https://github.com/CosmoCreeper/Sine/releases) and run it with Zen quit.

<details>
<summary><b>macOS: the installer only does half the job</b></summary>

Sine's bootloader installer (`browsercfg`, v0.1.8) prints
`As of v0.1.8 MacOS is not supported :(` and exits. The Sine installer still writes the
profile half (`chrome/JS/`, `chrome/utils/`), so it *looks* like it worked — but without
the program half nothing loads Sine at startup, and it never appears in Settings.

Install the missing half by hand. Two files from
[sineorg/bootloader](https://github.com/sineorg/bootloader) under `program/`:

```
program/config.js                    ->  Zen.app/Contents/Resources/config.js
program/defaults/pref/config-prefs.js -> Zen.app/Contents/Resources/defaults/pref/config-prefs.js
```

macOS 14+ **App Management** protection blocks `cp` from writing inside an app bundle —
including under `sudo`. Copy them in **Finder** instead (right-click Zen.app → Show
Package Contents), which has the entitlement and will just ask you to authenticate.

Then clear the startup cache and relaunch:

```bash
rm -rf ~/Library/Caches/zen/Profiles/*/startupCache
```

**Zen's auto-updater replaces the app bundle and wipes both files.** Re-copy them after
every Zen update.
</details>

### 2. Allow JS from unofficial sources

Sine only runs scripts from mods it fetched from its official store. Everything else gets
its CSS loaded and its **JavaScript silently skipped** — the mod appears installed and
does nothing.

Zen Settings → Sine → **"Enable installing JS from unofficial sources"**
(`sine.allow-unsafe-js`).

Understand what you're enabling: chrome-level JS has full browser privileges — every page,
every cookie, every session — and this toggle is global, covering any non-store mod you
install later.

### 3. Install the mod

In Sine's settings, install from URL:

```
https://github.com/hodgea/zen-tree-tabs
```

Restart Zen. Preferences appear in Sine's panel; they're plain about:config prefs under
`zen.tree-tabs.*`.

<details>
<summary>Installing from a local folder instead</summary>

Sine auto-discovers only what it installed itself, so a local mod needs registering:

```bash
PROF="$HOME/Library/Application Support/zen/Profiles/<your-profile>"
cp -R zen-tree-tabs "$PROF/chrome/sine-mods/zen-tree-tabs"
node -e 'const fs=require("fs"),d=process.argv[1]+"/chrome/sine-mods/",m=JSON.parse(fs.readFileSync(d+"mods.json","utf8")),t=JSON.parse(fs.readFileSync(d+"zen-tree-tabs/theme.json","utf8"));t.enabled=true;m[t.id]=t;fs.writeFileSync(d+"mods.json",JSON.stringify(m,null,2))' "$PROF"
```

The folder name must match the `id` in `theme.json`.
</details>

## How it works

Firefox already records the parent of every tab: `tabbrowser._createTab()` sets
`tab.openerTab` at creation. That's a live element reference that dies on restart, and
`tab.owner` gets nulled on the next tab switch — so `TabOpen` snapshots it into a UUID
persisted through SessionStore's custom tab values.

Everything else is derived. Depth, sibling order, collapse state and indentation are
recomputed from the parent map in one debounced pass, so DOM state can only drift for a
single frame.

Indentation deliberately routes through Zen's own `--zen-folder-indent` variable rather
than setting `margin-inline-start`, because Zen declares that with `!important` in
`zen-styles/zen-tabs/vertical-tabs.css` and would win. Feeding its variable inherits Zen's
indent transition for free.

| Behaviour | Notes |
|---|---|
| Nest on open | Parent captured at `TabOpen`, persisted across restarts |
| Reorder | New children move directly below their parent's existing subtree |
| Collapse / expand | Twisty arrow on parent tabs, plus a tab context-menu item |
| Close parent | Children promoted to the grandparent, or closed with it (pref) |

## What it deliberately leaves alone

Pinned tabs, essentials, folders, glance tabs and split-view groups have their own
positioning logic in `ZenFolders.mjs` / `ZenViewSplitter.mjs`. The `#eligible()` guard
excludes them, so the tree only covers ordinary unpinned tabs within one workspace.

## Known gaps

- **Drag and drop** doesn't move subtrees. Dragging a parent leaves its children behind,
  which then re-indent under whatever ends up above them. Needs hooks into
  `ZenDragAndDrop.js`.
- **Cross-window tab moves** lose the parent link — the id lookup is scoped to
  `gBrowser.tabs` in the current window.
- **Collapse hides via CSS `display: none`**, not `gBrowser.hideTab()`. Simpler and safer,
  but Ctrl+Tab still traverses concealed tabs.
- **Update churn.** Nothing here is a supported API. `openerTab`, `moveTabTo`'s options
  object and the `--zen-folder-indent` selector are all internals that can move on any
  Zen or Firefox rebase.

## Development

`node --check zen-tree-tabs.uc.js` catches syntax errors before a restart. Beyond that,
enable `zen.tree-tabs.debug` plus `devtools.chrome.enabled` and watch the Browser Console
(Cmd+Shift+J) — the script logs `[ztt] initialised with N tabs`.

To read the browser internals this hooks into:

```bash
mkdir -p /tmp/zen-omni && cd /tmp/zen-omni && unzip -o /Applications/Zen.app/Contents/Resources/browser/omni.ja
```

Relevant files: `chrome/browser/content/browser/tabbrowser/tabbrowser.js`,
`chrome/browser/content/browser/zen-components/ZenFolders.mjs`,
`chrome/browser/content/browser/zen-styles/zen-tabs/vertical-tabs.css`.
