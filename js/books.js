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
      const book = this.currentBook();
      if (btn) btn.hidden = false;
      if (!label) return;
      label.hidden = !book;
      if (book) label.textContent = book.name;
    }

    async refresh() {
      const previous = this.currentBook();
      this.books = await this.sync.listBooks();
      // A list that came back without the current book is the only proof
      // that the book has gone. listBooks throwing says nothing either way
      // and is left to reject, so a network blip never looks like a delete.
      if (this.sync.bookId && !this.books.some((b) => b.id === this.sync.bookId)) {
        await this.bookVanished(previous);
        return;
      }
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
          ${
            b.role === "owner"
              ? `<button type="button" class="book-rename" data-rename="${esc(b.id)}"
                   aria-label="Rename ${esc(b.name)}" title="Rename">✎</button>`
              : ""
          }
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
      // Deleting is for owners, and never for the last book standing —
      // there would be nowhere to put new recipes.
      const deleteBtn = $("#delete-book-btn");
      if (deleteBtn) {
        deleteBtn.hidden = !current || current.role !== "owner" || this.books.length < 2;
      }
    }

    /**
     * The book we were reading isn't ours any more — its owner deleted it,
     * or they took us out of it. Move to another of our books rather than
     * leave recipes on screen that exist nowhere and a sync that can only
     * fail, and drop the local copy that has outlived its book.
     */
    async bookVanished(lost) {
      const lostId = this.sync.bookId;
      const name = lost ? `“${lost.name}”` : "That book";
      let next = this.books[0];
      if (!next) {
        // Someone whose only book was another person's is left with none,
        // and new recipes still need somewhere to go. It is the first book
        // they have of their own, so it is named like one (J1.3).
        try {
          next = await this.sync.createBook(global.RecipeSync.ownBookName(this.sync.displayName));
          this.books = [next];
        } catch (err) {
          console.warn("Recipe Friend: could not replace the book that has gone.", err);
        }
      }
      if (!next) {
        // Offline, most likely. Stop syncing a book that isn't there and
        // leave the next refresh to finish the job.
        this.sync.setBook(null);
        this.app.store.useBook(null);
        this.app.store.forgetBook(lostId);
        this.app.render();
        this.renderHeader();
        this.renderDialog();
        this.app.toast(`${name} isn't available to you any more.`);
        return;
      }
      await this.switchTo(next.id);
      this.app.store.forgetBook(lostId);
      await this.refresh();
      this.app.toast(`${name} isn't available to you any more — you're in “${next.name}” now.`);
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
        const renameBtn = event.target.closest("[data-rename]");
        if (renameBtn) {
          this.beginRename(renameBtn.dataset.rename);
          return;
        }
        const btn = event.target.closest("[data-book]");
        if (btn) this.switchTo(btn.dataset.book);
      });

      // --- Move a recipe between books ---
      const moveDialog = $("#move-dialog");
      $("#move-cancel-btn").addEventListener("click", () => moveDialog.close());
      moveDialog.addEventListener("click", (event) => {
        if (event.target === moveDialog) moveDialog.close();
      });
      $("#move-list").addEventListener("click", async (event) => {
        const btn = event.target.closest("[data-target]");
        if (!btn || !this.movingId) return;
        const target = this.books.find((b) => b.id === btn.dataset.target);
        const recipeId = this.movingId;
        this.movingId = null;
        moveDialog.close();
        try {
          await this.sync.moveRecipe(recipeId, btn.dataset.target);
          // The row still exists, just in another book — forget it here
          // without a tombstone, which would delete it in its new home.
          this.app.store.removeLocal(recipeId);
          this.app.render();
          this.app.toast(`Moved to “${target ? target.name : "the other book"}”.`);
        } catch (err) {
          console.warn("Recipe Friend: could not move recipe.", err);
          this.app.toast("Couldn't move that recipe.");
        }
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

      $("#delete-book-btn").addEventListener("click", async () => {
        const current = this.currentBook();
        if (!current || current.role !== "owner") return;
        if (this.books.length < 2) {
          this.app.toast("This is your only book — create another one first.");
          return;
        }
        // Spell out exactly what is about to be destroyed, for everyone.
        let recipeCount = null;
        try {
          recipeCount = await this.sync.countRecipes(current.id);
        } catch {
          recipeCount = null;
        }
        const others = this.members.filter((m) => !m.isMe).length;
        const parts = [`Delete “${current.name}” for good?`];
        parts.push(
          recipeCount === null
            ? "Its recipes will be deleted."
            : `Its ${recipeCount} recipe${recipeCount === 1 ? "" : "s"} will be deleted.`
        );
        if (others > 0) {
          parts.push(`${others} other member${others === 1 ? "" : "s"} will lose it too.`);
        }
        parts.push("This cannot be undone — export first if you want a copy.");
        if (!confirm(parts.join("\n\n"))) return;

        try {
          await this.sync.deleteBook(current.id);
        } catch (err) {
          console.warn("Recipe Friend: could not delete book.", err);
          this.app.toast("Couldn't delete that book.");
          return;
        }
        this.app.store.forgetBook(current.id);
        this.books = this.books.filter((b) => b.id !== current.id);
        const next = this.books[0];
        this.sync.setBook(next ? next.id : null);
        this.app.store.useBook(next ? next.id : null);
        if (next) rememberSelection(this.sync.userId, next.id);
        if (next) await this.sync.syncNow();
        this.app.render();
        await this.refresh();
        this.app.toast(`Deleted “${current.name}”.`);
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
          } else {
            // Nothing left to sync with, and saying so keeps the refresh
            // below from reading a book we walked out of as one that was
            // deleted out from under us.
            this.sync.setBook(null);
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

    /** Swap a book's name for an input, in place. */
    beginRename(bookId) {
      const book = this.books.find((b) => b.id === bookId);
      const row = document.querySelector(`.book-item [data-book="${CSS.escape(bookId)}"]`);
      if (!book || !row) return;
      const input = document.createElement("input");
      input.type = "text";
      input.className = "book-rename-input";
      input.maxLength = 80;
      input.value = book.name;
      input.setAttribute("aria-label", "Book name");
      row.replaceWith(input);
      input.focus();
      input.select();

      let done = false;
      const commit = async (save) => {
        if (done) return;
        done = true;
        const name = input.value.trim();
        if (save && name && name !== book.name) {
          try {
            await this.sync.renameBook(bookId, name);
            book.name = name.slice(0, 80);
            this.app.toast("Book renamed.");
          } catch (err) {
            console.warn("Recipe Friend: could not rename book.", err);
            this.app.toast("Couldn't rename that book.");
          }
        }
        this.renderHeader();
        this.renderDialog();
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); commit(true); }
        if (event.key === "Escape") { event.preventDefault(); commit(false); }
      });
      input.addEventListener("blur", () => commit(true));
    }

    /** Offer the other books this recipe could move to. */
    openMove(recipeId) {
      const others = this.books.filter((b) => b.id !== this.sync.bookId);
      if (others.length === 0) {
        this.app.toast("Create another book first, then you can move recipes into it.");
        return;
      }
      this.movingId = recipeId;
      $("#move-list").innerHTML = others
        .map(
          (b) => `
        <li class="book-item">
          <button type="button" class="book-pick" data-target="${esc(b.id)}">${esc(b.name)}</button>
          <span class="book-role">${b.role === "owner" ? "yours" : "shared"}</span>
        </li>`
        )
        .join("");
      $("#move-dialog").showModal();
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
