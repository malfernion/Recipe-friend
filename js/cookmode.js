/**
 * cookmode.js — keeping the screen awake while someone cooks (J4.9–J4.14).
 *
 * A phone propped against the bread bin locks itself halfway through a
 * recipe, and hands covered in flour are the worst possible time to need a
 * passcode. The Screen Wake Lock API fixes that, with one sharp edge: the
 * browser drops the lock whenever the page is hidden, and does not give it
 * back. Glance at a text message and the screen quietly starts sleeping
 * again for the rest of the cook. So the lock is re-taken on the way back
 * (J4.11), which is most of what this file is for.
 *
 * Nothing here touches the DOM. The navigator and the storage are handed
 * in, so the whole thing can be asked questions from a test.
 */
(function (global) {
  "use strict";

  const PREF_KEY = "recipe-friend:cook-mode";

  class CookMode {
    constructor(options = {}) {
      this.nav = options.navigator || global.navigator;
      this.storage = options.storage || global.localStorage;
      // Told whenever the answer to "is the screen being held awake?"
      // changes, so the control can say so rather than being invisible state.
      this.onChange = options.onChange || (() => {});
      this.sentinel = null;
      this.open = false; // is a recipe on screen
      this.wanted = this.remembered();
    }

    /** Can this browser do it at all? If not, the control is not offered. */
    get supported() {
      return Boolean(this.nav && this.nav.wakeLock && typeof this.nav.wakeLock.request === "function");
    }

    /** Is a lock actually held right now — not merely wanted. */
    get active() {
      return Boolean(this.sentinel);
    }

    /**
     * The choice lives on the device (J4.12). Measurement preferences
     * follow the person; this follows the phone propped in front of them.
     */
    remembered() {
      try {
        return this.storage.getItem(PREF_KEY) === "on";
      } catch {
        return false; // private browsing: a fresh choice each time is fine
      }
    }

    remember(on) {
      try {
        if (on) this.storage.setItem(PREF_KEY, "on");
        else this.storage.removeItem(PREF_KEY);
      } catch {
        /* remembering is a convenience, not a requirement */
      }
    }

    /** A recipe opened. Take the lock back if it was already wanted. */
    async enter() {
      this.open = true;
      if (this.wanted) await this.acquire();
    }

    /**
     * The recipe closed, however it closed. The preference stays; the lock
     * does not (J4.10) — a phone back in a pocket must not still be awake.
     */
    async leave() {
      this.open = false;
      await this.release();
    }

    async toggle() {
      if (this.wanted) return this.disable();
      return this.enable();
    }

    async enable() {
      this.wanted = true;
      this.remember(true);
      const ok = await this.acquire();
      // Asked for and refused: don't leave a toggle claiming to be on.
      if (!ok) {
        this.wanted = false;
        this.remember(false);
      }
      this.onChange();
      return ok;
    }

    async disable() {
      this.wanted = false;
      this.remember(false);
      await this.release();
      this.onChange();
      return true;
    }

    /**
     * Coming back to the page. The browser dropped the lock while we were
     * away, so take it again — but only if a recipe is still open and it
     * is still wanted (J4.11).
     */
    async resume() {
      if (!this.open || !this.wanted || this.active) return false;
      const ok = await this.acquire();
      this.onChange();
      return ok;
    }

    /** Never a reason a recipe fails to open (J4.14): refusals are absorbed. */
    async acquire() {
      if (!this.supported || this.sentinel) return this.active;
      try {
        const sentinel = await this.nav.wakeLock.request("screen");
        this.sentinel = sentinel;
        // The browser releases it on its own when the page is hidden; hear
        // about it so the control stops claiming the screen is held.
        if (typeof sentinel.addEventListener === "function") {
          sentinel.addEventListener("release", () => {
            if (this.sentinel === sentinel) this.sentinel = null;
            this.onChange();
          });
        }
        this.onChange();
        return true;
      } catch (err) {
        console.warn("Recipe Friend: could not keep the screen awake.", err);
        this.sentinel = null;
        return false;
      }
    }

    async release() {
      const sentinel = this.sentinel;
      this.sentinel = null;
      if (!sentinel) return;
      try {
        await sentinel.release();
      } catch (err) {
        console.warn("Recipe Friend: could not release the screen lock.", err);
      }
      this.onChange();
    }
  }

  global.RecipeCookMode = { CookMode, PREF_KEY };
})(window);
