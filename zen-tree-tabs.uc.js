// ==UserScript==
// @name           Zen Tree Style Tabs
// @description    Automatic opener-based tab hierarchy for Zen's vertical sidebar
// @include        chrome://browser/content/browser.xhtml
// ==/UserScript==

/*
 * How this works
 * --------------
 * Firefox already records the parent of every tab: `tabbrowser._createTab()` sets
 * `tab.openerTab` at creation time. That property is a live element reference and
 * does not survive a restart, so on TabOpen we snapshot it into a stable string id
 * that we persist through SessionStore's custom tab values.
 *
 * Everything else is derived. Depth, sibling order, collapse state and the
 * indentation variable are recomputed from the parent map in a single debounced
 * pass, so there is exactly one place where DOM state can drift out of sync.
 *
 * Zen-specific carve-outs (see #eligible): pinned tabs, essentials, folders,
 * glance tabs and split-view groups all have their own positioning logic in
 * ZenFolders.mjs / ZenViewSplitter.mjs. We leave them alone entirely and only
 * build a tree out of ordinary unpinned tabs within a single workspace.
 */

(() => {
  const PREF = "zen.tree-tabs.";
  const ID_KEY = "ztt-id";
  const PARENT_KEY = "ztt-parent";
  const COLLAPSED_KEY = "ztt-collapsed";

  // Sine re-runs scripts on mod update; tear down the old instance first.
  if (window.gZenTreeTabs) {
    try {
      window.gZenTreeTabs.destroy();
    } catch (e) {
      console.error("[ztt] failed to tear down previous instance", e);
    }
  }

  // Firefox 158 moved browser/components modules to moz-src:///; the old resource:///
  // URL no longer resolves, and an import failure here kills the whole script silently.
  const SessionStore = (() => {
    for (const url of [
      "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
      "resource:///modules/sessionstore/SessionStore.sys.mjs",
    ]) {
      try {
        return ChromeUtils.importESModule(url).SessionStore;
      } catch (e) {
        // try the next location
      }
    }
    throw new Error("[ztt] could not locate SessionStore.sys.mjs");
  })();

  class ZenTreeTabs {
    #listeners = [];
    #refreshHandle = null;
    #destroyed = false;

    constructor() {
      this.#on(gBrowser.tabContainer, "TabOpen", this.#onTabOpen);
      this.#on(gBrowser.tabContainer, "TabClose", this.#onTabClose);
      this.#on(gBrowser.tabContainer, "TabMove", this.#scheduleRefresh);
      this.#on(gBrowser.tabContainer, "TabSelect", this.#onTabSelect);
      this.#on(gBrowser.tabContainer, "TabGroupExpand", this.#scheduleRefresh);
      this.#on(gBrowser.tabContainer, "TabGroupCollapse", this.#scheduleRefresh);
      this.#on(window, "SSTabRestoring", this.#onTabRestoring);

      // Zen fires this when switching workspaces; tabs get shown/hidden wholesale.
      this.#on(window, "ZenWorkspacesUIUpdate", this.#scheduleRefresh);

      this.#installContextMenu();

      // Adopt whatever is already open (mod installed mid-session, or window reopen).
      for (const tab of gBrowser.tabs) {
        this.#adopt(tab);
      }
      this.#refresh();
      this.#log("initialised with", gBrowser.tabs.length, "tabs");
    }

    /* ------------------------------------------------------------------ prefs */

    #bool(name, fallback) {
      return Services.prefs.getBoolPref(PREF + name, fallback);
    }

    #int(name, fallback) {
      // Sine writes numeric prefs as strings, so accept either.
      const raw = Services.prefs.getStringPref(PREF + name, String(fallback));
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : fallback;
    }

    get enabled() {
      return this.#bool("enabled", true);
    }

    #log(...args) {
      if (this.#bool("debug", false)) {
        console.log("[ztt]", ...args);
      }
    }

    /* ------------------------------------------------------- identity + state */

    /** Stable per-tab id that survives session restore. */
    #id(tab) {
      let id = tab.getAttribute(ID_KEY);
      if (!id) {
        id = SessionStore.getCustomTabValue(tab, ID_KEY);
        if (!id) {
          id = Services.uuid.generateUUID().toString();
          SessionStore.setCustomTabValue(tab, ID_KEY, id);
        }
        tab.setAttribute(ID_KEY, id);
      }
      return id;
    }

    #tabById(id) {
      if (!id) {
        return null;
      }
      return gBrowser.tabs.find((t) => !t.closing && this.#id(t) === id) ?? null;
    }

    #parentOf(tab) {
      return this.#tabById(tab.getAttribute(PARENT_KEY));
    }

    #setParent(tab, parent) {
      if (parent && (parent === tab || this.#isAncestor(tab, parent))) {
        return; // never allow a cycle
      }
      if (parent) {
        const id = this.#id(parent);
        tab.setAttribute(PARENT_KEY, id);
        SessionStore.setCustomTabValue(tab, PARENT_KEY, id);
      } else {
        tab.removeAttribute(PARENT_KEY);
        SessionStore.setCustomTabValue(tab, PARENT_KEY, "");
      }
    }

    /** Restore persisted ids/parent onto a tab's attributes. */
    #adopt(tab) {
      const id = SessionStore.getCustomTabValue(tab, ID_KEY);
      if (id) {
        tab.setAttribute(ID_KEY, id);
      }
      const parent = SessionStore.getCustomTabValue(tab, PARENT_KEY);
      if (parent) {
        tab.setAttribute(PARENT_KEY, parent);
      }
      if (SessionStore.getCustomTabValue(tab, COLLAPSED_KEY) === "true") {
        tab.setAttribute(COLLAPSED_KEY, "true");
      }
    }

    /* ---------------------------------------------------------- tree queries */

    /**
     * Which tabs take part in the tree. Everything excluded here is owned by
     * one of Zen's own layout systems and must keep its native positioning.
     */
    #eligible(tab) {
      return (
        tab?.isConnected &&
        !tab.closing &&
        !tab.pinned &&
        !tab.hasAttribute("zen-glance-tab") &&
        !tab.hasAttribute("zen-empty-tab") &&
        // Zen's own split-view groups, plus Firefox's native <tab-split-view-wrapper>
        // (tab.splitview) which moveTabTo treats as one unit.
        !tab.splitview &&
        !tab.group?.hasAttribute("split-view-group") &&
        !tab.group?.isZenFolder
      );
    }

    #sameWorkspace(a, b) {
      return (
        a.getAttribute("zen-workspace-id") === b.getAttribute("zen-workspace-id")
      );
    }

    #isAncestor(candidate, tab) {
      let cursor = this.#parentOf(tab);
      const seen = new Set();
      while (cursor && !seen.has(cursor)) {
        if (cursor === candidate) {
          return true;
        }
        seen.add(cursor);
        cursor = this.#parentOf(cursor);
      }
      return false;
    }

    #depth(tab) {
      let depth = 0;
      let cursor = this.#parentOf(tab);
      const seen = new Set();
      while (cursor && !seen.has(cursor)) {
        depth++;
        seen.add(cursor);
        cursor = this.#parentOf(cursor);
      }
      return depth;
    }

    #childrenOf(tab) {
      const id = this.#id(tab);
      return gBrowser.tabs.filter(
        (t) => !t.closing && t.getAttribute(PARENT_KEY) === id
      );
    }

    /** Depth-first descendants in visual order. */
    #descendantsOf(tab) {
      const out = [];
      const walk = (node) => {
        for (const child of this.#childrenOf(node)) {
          out.push(child);
          walk(child);
        }
      };
      walk(tab);
      return out;
    }

    #hasCollapsedAncestor(tab) {
      let cursor = this.#parentOf(tab);
      const seen = new Set();
      while (cursor && !seen.has(cursor)) {
        if (cursor.getAttribute(COLLAPSED_KEY) === "true") {
          return true;
        }
        seen.add(cursor);
        cursor = this.#parentOf(cursor);
      }
      return false;
    }

    /* -------------------------------------------------------------- handlers */

    #onTabOpen = (event) => {
      if (!this.enabled) {
        return;
      }
      const tab = event.target;

      // `openerTab` is only meaningful right now — gBrowser nulls `owner` on the
      // next tab switch, and the element reference dies on restart. Snapshot it.
      let opener = tab.openerTab;
      if (opener?.hasAttribute("zen-glance-tab")) {
        opener = gZenGlanceManager?.getTabOrGlanceParent(opener) ?? opener;
      }

      if (
        this.#eligible(tab) &&
        this.#eligible(opener) &&
        this.#sameWorkspace(tab, opener)
      ) {
        this.#setParent(tab, this.#clampDepth(opener));
        if (this.#bool("reorder-on-open", true)) {
          // Defer: gBrowser is still settling this tab's index inside TabOpen.
          Services.tm.dispatchToMainThread(() => this.#placeUnderParent(tab));
        }
      }
      this.#scheduleRefresh();
    };

    /**
     * Walk up from `opener` until attaching a child would stay within max-depth.
     * Keeps deep chains readable instead of indenting off the edge of the sidebar.
     */
    #clampDepth(opener) {
      const max = Math.max(1, this.#int("max-depth", 8));
      let cursor = opener;
      while (cursor && this.#depth(cursor) + 1 > max) {
        const next = this.#parentOf(cursor);
        if (!next) {
          break;
        }
        cursor = next;
      }
      return cursor;
    }

    #onTabClose = (event) => {
      const tab = event.target;
      const children = this.#childrenOf(tab);
      if (!children.length) {
        this.#scheduleRefresh();
        return;
      }

      if (this.#bool("close-subtree", false)) {
        const doomed = this.#descendantsOf(tab);
        this.#log("closing subtree of", tab.label, doomed.length, "descendants");
        Services.tm.dispatchToMainThread(() => {
          for (const child of doomed.reverse()) {
            if (child.isConnected && !child.closing) {
              gBrowser.removeTab(child, { animate: false });
            }
          }
        });
      } else {
        // Promote children to the grandparent so the subtree stays reachable.
        const grandparent = this.#parentOf(tab);
        for (const child of children) {
          this.#setParent(child, grandparent);
        }
      }
      this.#scheduleRefresh();
    };

    #onTabSelect = (event) => {
      const tab = event.target;
      // Selecting a concealed tab (Ctrl+Tab, address bar switch) reveals it.
      if (this.#hasCollapsedAncestor(tab)) {
        let cursor = this.#parentOf(tab);
        const seen = new Set();
        while (cursor && !seen.has(cursor)) {
          cursor.removeAttribute(COLLAPSED_KEY);
          SessionStore.setCustomTabValue(cursor, COLLAPSED_KEY, "false");
          seen.add(cursor);
          cursor = this.#parentOf(cursor);
        }
      }
      this.#scheduleRefresh();
    };

    #onTabRestoring = (event) => {
      this.#adopt(event.target);
      this.#scheduleRefresh();
    };

    /* --------------------------------------------------------------- actions */

    /** Move `tab` to sit immediately after its parent's existing subtree. */
    #placeUnderParent(tab) {
      const parent = this.#parentOf(tab);
      if (!parent?.isConnected || !tab.isConnected || tab.closing) {
        return;
      }
      const siblings = this.#descendantsOf(parent).filter((t) => t !== tab);
      const anchor = siblings.length ? siblings[siblings.length - 1] : parent;

      const from = gBrowser.tabs.indexOf(tab);
      const anchorIndex = gBrowser.tabs.indexOf(anchor);
      if (from === -1 || anchorIndex === -1) {
        return;
      }
      // Account for the hole `tab` leaves behind when moving downward.
      const to = from < anchorIndex ? anchorIndex : anchorIndex + 1;
      if (to !== from) {
        gBrowser.moveTabTo(tab, { tabIndex: to });
      }
    }

    toggleCollapse(tab) {
      if (!this.#childrenOf(tab).length) {
        return;
      }
      const collapsed = tab.getAttribute(COLLAPSED_KEY) === "true";
      if (collapsed) {
        tab.removeAttribute(COLLAPSED_KEY);
      } else {
        // Don't strand the selected tab inside a collapsed subtree.
        if (this.#descendantsOf(tab).includes(gBrowser.selectedTab)) {
          gBrowser.selectedTab = tab;
        }
        tab.setAttribute(COLLAPSED_KEY, "true");
      }
      SessionStore.setCustomTabValue(tab, COLLAPSED_KEY, String(!collapsed));
      this.#refresh();
    }

    closeSubtree(tab) {
      const doomed = [...this.#descendantsOf(tab).reverse(), tab];
      for (const t of doomed) {
        if (t.isConnected && !t.closing) {
          gBrowser.removeTab(t, { animate: false });
        }
      }
    }

    /* ---------------------------------------------------------------- render */

    #scheduleRefresh = () => {
      if (this.#destroyed || this.#refreshHandle !== null) {
        return;
      }
      this.#refreshHandle = window.requestAnimationFrame(() => {
        this.#refreshHandle = null;
        this.#refresh();
      });
    };

    /**
     * Single source of truth for the visual state. Everything the CSS keys off
     * is written here, so a stale attribute can only ever last one frame.
     */
    #refresh() {
      if (this.#destroyed) {
        return;
      }
      const on = this.enabled;
      const indent = Math.max(0, this.#int("indent-px", 14));
      const twisty = this.#bool("show-twisty", true);

      document.documentElement.toggleAttribute("ztt-active", on);

      for (const tab of gBrowser.tabs) {
        if (!on || !this.#eligible(tab)) {
          this.#clearTab(tab);
          continue;
        }

        const depth = this.#depth(tab);
        const kids = this.#childrenOf(tab).length;

        tab.style.setProperty("--ztt-indent", `${depth * indent}px`);
        tab.setAttribute("ztt-depth", depth);
        tab.toggleAttribute("ztt-has-children", kids > 0);
        tab.toggleAttribute("ztt-concealed", this.#hasCollapsedAncestor(tab));

        if (kids === 0) {
          tab.removeAttribute(COLLAPSED_KEY);
        }
        this.#syncTwisty(tab, twisty && kids > 0);
      }
    }

    #clearTab(tab) {
      tab.style.removeProperty("--ztt-indent");
      tab.removeAttribute("ztt-depth");
      tab.removeAttribute("ztt-has-children");
      tab.removeAttribute("ztt-concealed");
      this.#syncTwisty(tab, false);
    }

    /**
     * A real element rather than a pseudo-element: pseudo-elements can't own a
     * click target, and we need the toggle to not also select the tab.
     */
    #syncTwisty(tab, wanted) {
      const existing = tab.querySelector(".ztt-twisty");
      if (!wanted) {
        existing?.remove();
        return;
      }
      if (existing) {
        return;
      }
      const content = tab.querySelector(".tab-content");
      if (!content) {
        return;
      }
      const button = document.createXULElement("image");
      button.className = "ztt-twisty";
      button.addEventListener("mousedown", (event) => {
        event.stopPropagation();
        event.preventDefault();
      });
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        event.preventDefault();
        this.toggleCollapse(tab);
      });
      content.prepend(button);
    }

    /* ---------------------------------------------------------- context menu */

    #installContextMenu() {
      const menu = document.getElementById("tabContextMenu");
      if (!menu || menu.querySelector("#ztt-context-collapse")) {
        return;
      }

      const separator = document.createXULElement("menuseparator");
      separator.id = "ztt-context-separator";

      const collapse = document.createXULElement("menuitem");
      collapse.id = "ztt-context-collapse";
      collapse.addEventListener("command", () =>
        this.toggleCollapse(TabContextMenu.contextTab)
      );

      const close = document.createXULElement("menuitem");
      close.id = "ztt-context-close-subtree";
      close.setAttribute("label", "Close tab and children");
      close.addEventListener("command", () =>
        this.closeSubtree(TabContextMenu.contextTab)
      );

      menu.append(separator, collapse, close);

      this.#on(menu, "popupshowing", (event) => {
        // popupshowing bubbles up from submenus (move-to-group, share, ...).
        if (event.target !== menu) {
          return;
        }
        const tab = TabContextMenu.contextTab;
        const kids = tab && this.#eligible(tab) ? this.#childrenOf(tab).length : 0;
        const show = this.enabled && kids > 0;

        separator.hidden = collapse.hidden = close.hidden = !show;
        if (show) {
          collapse.setAttribute(
            "label",
            tab.getAttribute(COLLAPSED_KEY) === "true"
              ? "Expand subtree"
              : "Collapse subtree"
          );
        }
      });
    }

    /* --------------------------------------------------------------- teardown */

    #on(target, type, handler) {
      const bound = handler.bind(this);
      target.addEventListener(type, bound);
      this.#listeners.push([target, type, bound]);
    }

    destroy() {
      this.#destroyed = true;
      if (this.#refreshHandle !== null) {
        window.cancelAnimationFrame(this.#refreshHandle);
      }
      for (const [target, type, handler] of this.#listeners) {
        target.removeEventListener(type, handler);
      }
      this.#listeners = [];

      for (const tab of gBrowser.tabs) {
        this.#clearTab(tab);
      }
      document.documentElement.removeAttribute("ztt-active");
      for (const id of [
        "ztt-context-separator",
        "ztt-context-collapse",
        "ztt-context-close-subtree",
      ]) {
        document.getElementById(id)?.remove();
      }
      window.gZenTreeTabs = null;
    }
  }

  const start = () => {
    window.gZenTreeTabs = new ZenTreeTabs();
  };

  if (gBrowserInit?.delayedStartupFinished) {
    start();
  } else {
    const observer = (subject) => {
      if (subject === window) {
        Services.obs.removeObserver(observer, "browser-delayed-startup-finished");
        start();
      }
    };
    Services.obs.addObserver(observer, "browser-delayed-startup-finished");
  }
})();
