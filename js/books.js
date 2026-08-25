/**
 * books.js — recipe books, members, and invite links (M3).
 *
 * A book is a shared recipe collection. Everyone signed in has at least
 * their own; a household is simply a book several people belong to.
 * Switching books swaps the local cache (see RecipeStore.useBook) so one
 * book's recipes can never be pushed into another.
 */
(function (global) {
  "use strict";

  const SELECTED_KEY = "recipe-friend:selected-book";

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) =>
    String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  function rememberSelection(userId, bookId) {
    try {
      global.localStorage.setItem(`${SELECTED_KEY}:${userId}`, bookId);
    } catch {
      /* remembering is a convenience, not a requirement */
    }
  }

  function rememberedSelection(userId) {
    try {
      return global.localStorage.getItem(`${SELECTED_KEY}:${userId}`);
    } catch {
      return null;
    }
  }

  class BooksUI {
    constructor(sync, app) {
      this.sync = sync;
      this.app = app;
      this.books = [];
      this.members = [];
      this.dialog = $("#books-dialog");
      this.wired = false;
    }

    currentBook() {
      return this.books.find((b) => b.id === this.sync.bookId) || null;
    }

    /** Header shows which book you are cooking from, once there's a choice. */
    renderHeader() {
      const label = $("#current-book");
      const btn = $("#books-btn");
      const sep = document.querySelector(".book-sep");
      const book = this.currentBook();
      if (btn) btn.hidden = false;
      if (sep) sep.hidden = false;
      if (!label) return;
      label.hidden = !book;
      if (book) label.textContent = book.name;
    }

    async refresh() {
      this.books = await this.sync.listBooks();
      try {
        this.members = await this.sync.listMembers(this.sync.bookId);
      } catch (err) {
        console.warn("Recipe Friend: could not load members.", err);
        this.members = [];
      }
      this.renderHeader();
      this.renderDialog();
    }

    renderDialog() {
      const list = $("#book-list");
      if (!list) return;
      list.innerHTML = this.books
        .map(
          (b) => `
        <li class="book-item ${b.id === this.sync.bookId ? "book-current" : ""}">
          <button type="button" class="book-pick" data-book="${esc(b.id)}"
                  ${b.id === this.sync.bookId ? 'aria-current="true"' : ""}>
            ${esc(b.name)}
          </button>
          <span class="book-role">${b.role === "owner" ? "yours" : "shared"}</span>
        </li>`
        )
        .join("");

      const current = this.currentBook();
      const nameEl = $("#sharing-book-name");
      if (nameEl) nameEl.textContent = current ? `· ${current.name}` : "";

      const memberList = $("#member-list");
      if (memberList) {
        const iOwn = current && current.role === "owner";
        memberList.innerHTML = this.members
          .map(
            (m) => `
          <li class="member-item">
            <span class="member-name">${esc(m.name)}${m.isMe ? " (you)" : ""}</span>
            <span class="member-role">${esc(m.role)}</span>
            ${
              iOwn && !m.isMe
                ? `<button type="button" class="member-remove" data-remove="${esc(m.userId)}"
                     aria-label="Remove ${esc(m.name)}" title="Remove from book">×</button>`
                : ""
            }
          </li>`
          )
          .join("");
      }

      // Owners can't walk out on their own book — that would orphan it.
      const leaveBtn = $("#leave-book-btn");
      if (leaveBtn) leaveBtn.hidden = !current || current.role === "owner";
      const inviteBtn = $("#invite-btn");
      if (inviteBtn) inviteBtn.hidden = !current || current.role !== "owner";
    }

    async switchTo(bookId) {
      if (!bookId || bookId === this.sync.bookId) return;
      this.sync.setBook(bookId);
      this.app.store.useBook(bookId);
      rememberSelection(this.sync.userId, bookId);
      this.app.render();
      await this.sync.syncNow();
      this.app.render();
      this.renderHeader();
      this.renderDialog();
    }

    wire() {
      if (this.wired) return;
      this.wired = true;

      $("#books-btn").addEventListener("click", async () => {
        this.dialog.showModal();
        await this.refresh();
      });
      $("#books-close-btn").addEventListener("click", () => this.dialog.close());
      this.dialog.addEventListener("click", (event) => {
        if (event.target === this.dialog) this.dialog.close();
      });

      $("#book-list").addEventListener("click", (event) => {
        const btn = event.target.closest("[data-book]");
        if (btn) this.switchTo(btn.dataset.book);
      });

      $("#create-book-btn").addEventListener("click", async () => {
        const input = $("#new-book-name");
        const name = input.value.trim();
        if (!name) return;
        try {
          const book = await this.sync.createBook(name);
          input.value = "";
          this.books.push(book);
          await this.switchTo(book.id);
          await this.refresh();
          this.app.toast(`Created “${book.name}”.`);
        } catch (err) {
          console.warn("Recipe Friend: could not create book.", err);
          this.app.toast("Couldn't create that book.");
        }
      });

      $("#invite-btn").addEventListener("click", async () => {
        const out = $("#invite-out");
        try {
          const code = await this.sync.createInvite(this.sync.bookId);
          const url = `${location.origin}${location.pathname}#join=${code}`;
          out.hidden = false;
          out.textContent = url;
          try {
            await navigator.clipboard.writeText(url);
            this.app.toast("Invite link copied — it works for 7 days.");
          } catch {
            this.app.toast("Invite link ready — copy it from below.");
          }
        } catch (err) {
          console.warn("Recipe Friend: could not create invite.", err);
          this.app.toast("Couldn't create an invite link.");
        }
      });

      $("#member-list").addEventListener("click", async (event) => {
        const btn = event.target.closest("[data-remove]");
        if (!btn) return;
        if (!confirm("Remove this person from the book?")) return;
        try {
          await this.sync.removeMember(this.sync.bookId, btn.dataset.remove);
          await this.refresh();
        } catch (err) {
          console.warn("Recipe Friend: could not remove member.", err);
          this.app.toast("Couldn't remove that person.");
        }
      });

      $("#leave-book-btn").addEventListener("click", async () => {
        const current = this.currentBook();
        if (!current || current.role === "owner") return;
        if (!confirm(`Leave “${current.name}”? Its recipes stay with the book.`)) return;
        try {
          await this.sync.leaveBook(current.id);
          // Drop this book's local cache so it doesn't linger on the device.
          this.app.store.useBook(null);
          this.books = this.books.filter((b) => b.id !== current.id);
          const next = this.books[0];
          if (next) {
            this.sync.setBook(next.id);
            this.app.store.useBook(next.id);
            rememberSelection(this.sync.userId, next.id);
            await this.sync.syncNow();
          }
          this.app.render();
          await this.refresh();
          this.app.toast(`Left “${current.name}”.`);
        } catch (err) {
          console.warn("Recipe Friend: could not leave book.", err);
          this.app.toast("Couldn't leave that book.");
        }
      });
    }

    /** Redeem an invite code from a #join= link. */
    async join(code) {
      try {
        const book = await this.sync.redeemInvite(code);
        await this.refresh();
        await this.switchTo(book.id);
        this.app.toast(`Joined “${book.name}”.`);
        return true;
      } catch (err) {
        console.warn("Recipe Friend: could not join book.", err);
        this.app.toast("That invite link is invalid or has expired.");
        return false;
      }
    }
  }

  global.RecipeBooks = { BooksUI, rememberSelection, rememberedSelection };
})(window);
