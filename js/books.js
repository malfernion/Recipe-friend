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
  const esc = global.RecipeHTML.escapeHTML;

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
    constructor(sync, api, app) {
      this.sync = sync;
      // Books, members and invites are data access, not sync. Taking the
      // api directly is what stops this file asking an object called
      // "sync" to mint an invite.
      this.api = api;
      this.app = app;
      this.books = [];
      this.members = [];
      this.invites = [];
      this.dialog = $("#books-dialog");
      this.wired = false;
    }

    /**
     * May we change what is in this book? Ownership answers it outright;
     * otherwise it is the role the membership row carries (J7.17). An
     * unknown role is treated as read-only: a control that does nothing
     * is worse than one that is not offered, and the database will refuse
     * anyway.
     */
    canEdit(book) {
      const b = book || this.currentBook();
      if (!b) return false;
      return Boolean(b.isOwner) || b.role === "owner" || b.role === "editor";
    }

    /** Books this person could put a recipe into. */
    writableBooks() {
      return this.books.filter((b) => this.canEdit(b));
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
      this.books = await this.api.listBooks();
      // A list that came back without the current book is the only proof
      // that the book has gone. listBooks throwing says nothing either way
      // and is left to reject, so a network blip never looks like a delete.
      if (this.sync.bookId && !this.books.some((b) => b.id === this.sync.bookId)) {
        await this.bookVanished(previous);
        return;
      }
      try {
        this.members = await this.api.listMembers(this.sync.bookId);
      } catch (err) {
        console.warn("Recipe Friend: could not load members.", err);
        this.members = [];
      }
      // Only owners can read the invites table, so a failure here is the
      // normal case for a book you were invited into, not an error.
      const current = this.currentBook();
      if (current && current.isOwner) {
        try {
          this.invites = await this.api.listInvites(current.id);
        } catch (err) {
          console.warn("Recipe Friend: could not load invites.", err);
          this.invites = [];
        }
      } else {
        this.invites = [];
      }
      // What we may do in the book we are already in can change under us:
      // a role taken down to viewer arrives as an ordinary refresh, with
      // no other announcement (J7.17).
      this.applyRole();
      this.renderHeader();
      this.renderDialog();
    }

    /** Tell sync and the UI what this book allows, from one answer. */
    applyRole() {
      const editable = this.canEdit(this.currentBook());
      this.sync.readOnly = !editable;
      if (this.app.setCanEdit) this.app.setCanEdit(editable);
    }

    /**
     * Outstanding invites, so an owner can see what is live in their name
     * and tear one up. An invite is a bearer token — anyone holding the
     * link can walk in — so leaving one live and unaccounted for is the
     * thing to avoid.
     */
    renderInvites(iOwn) {
      const list = $("#invite-list");
      const empty = $("#invite-empty");
      if (!list) return;
      if (!iOwn) {
        list.innerHTML = "";
        if (empty) empty.hidden = true;
        return;
      }
      if (empty) empty.hidden = this.invites.length > 0;
      list.innerHTML = this.invites
        .map((inv) => {
          const left = Math.max(0, inv.maxUses - inv.usedCount);
          const spent = left === 0;
          const when = new Date(inv.expiresAt);
          const hours = Math.max(0, Math.round((when - Date.now()) / 3600000));
          const life = hours >= 24
            ? `${Math.round(hours / 24)} day${Math.round(hours / 24) === 1 ? "" : "s"} left`
            : `${hours} hour${hours === 1 ? "" : "s"} left`;
          const uses = spent
            ? "used up"
            : `${left} of ${inv.maxUses} use${inv.maxUses === 1 ? "" : "s"} left`;
          return `
        <li class="invite-item${spent ? " invite-spent" : ""}">
          <code class="invite-code">…${esc(inv.code.slice(-6))}</code>
          <span class="invite-life">${esc(uses)} · ${esc(life)}</span>
          <button type="button" class="invite-revoke" data-revoke="${esc(inv.code)}"
                  aria-label="Revoke invite ending ${esc(inv.code.slice(-6))}"
                  title="Revoke this link">×</button>
        </li>`;
        })
        .join("");
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
            b.isOwner
              ? `<button type="button" class="book-rename" data-rename="${esc(b.id)}"
                   aria-label="Rename ${esc(b.name)}" title="Rename">✎</button>`
              : ""
          }
          <span class="book-role">${b.isOwner ? "yours" : "shared"}</span>
        </li>`
        )
        .join("");

      const current = this.currentBook();
      const nameEl = $("#sharing-book-name");
      if (nameEl) nameEl.textContent = current ? `· ${current.name}` : "";

      // Ownership decides every control below, and it comes from
      // books.owner rather than the membership row's role.
      const iOwn = Boolean(current && current.isOwner);

      const memberList = $("#member-list");
      if (memberList) {
        memberList.innerHTML = this.members
          .map(
            (m) => `
          <li class="member-item">
            <span class="member-name">${esc(m.name)}${m.isMe ? " (you)" : ""}</span>
            ${
              iOwn && !m.isMe
                ? `<label class="member-role-field">
                     <span class="visually-hidden">What ${esc(m.name)} may do</span>
                     <select class="member-role-pick" data-role-for="${esc(m.userId)}">
                       <option value="editor"${m.role === "viewer" ? "" : " selected"}>Can add and edit</option>
                       <option value="viewer"${m.role === "viewer" ? " selected" : ""}>Can read only</option>
                     </select>
                   </label>`
                : `<span class="member-role">${esc(m.role)}</span>`
            }
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
      // Everyone else always gets a way out, however they ended up here.
      const leaveBtn = $("#leave-book-btn");
      if (leaveBtn) leaveBtn.hidden = !current || current.isOwner;
      const inviteBtn = $("#invite-btn");
      if (inviteBtn) inviteBtn.hidden = !iOwn;
      // Deleting is for owners, and never for the last book standing —
      // there would be nowhere to put new recipes.
      const deleteBtn = $("#delete-book-btn");
      if (deleteBtn) deleteBtn.hidden = !iOwn || this.books.length < 2;

      this.renderInvites(iOwn);
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
          next = await this.api.createBook(global.RecipeApi.ownBookName(this.sync.displayName));
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
      const book = this.books.find((b) => b.id === bookId);
      this.sync.setBook(bookId, { readOnly: !this.canEdit(book) });
      if (this.app.setCanEdit) this.app.setCanEdit(this.canEdit(book));
      this.app.store.useBook(bookId);
      rememberSelection(this.sync.userId, bookId);
      this.app.render();
      await this.sync.syncNow();
      this.app.render();
      this.renderHeader();
      this.renderDialog();
    }

    /**
     * Wire the dialog up once. Split by what each group is about rather
     * than left as one long method: the four concerns below share nothing
     * but the dialog they live in.
     */
    wire() {
      if (this.wired) return;
      this.wired = true;
      this.wireDialog();
      this.wireMove();
      this.wireSharing();
    }

    /**
     * Opening and closing the dialog, and the list of books inside it:
     * picking one, renaming one, making one.
     */
    wireDialog() {
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

      $("#create-book-btn").addEventListener("click", async () => {
        const input = $("#new-book-name");
        const name = input.value.trim();
        if (!name) return;
        try {
          const book = await this.api.createBook(name);
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
    }

    /**
     * Moving a recipe to another book. It lives here because the list of
     * books to move it to is this file's, not app.js's.
     */
    wireMove() {
      const moveDialog = $("#move-dialog");
      $("#move-cancel-btn").addEventListener("click", () => moveDialog.close());
      moveDialog.addEventListener("click", (event) => {
        if (event.target === moveDialog) moveDialog.close();
      });
      $("#move-list").addEventListener("click", async (event) => {
        const btn = event.target.closest("[data-target]");
        if (!btn || !this.movingId) return;
        const target = this.books.find((b) => b.id === btn.dataset.target);
        const where = target ? target.name : "the other book";
        const recipeId = this.movingId;
        const verb = this.transferVerb;
        this.movingId = null;
        moveDialog.close();

        // A move takes the recipe out of a book other people are reading,
        // so it asks first and names what goes where — the same courtesy
        // deleting one gets (J2.10). A copy adds and takes nothing.
        if (verb === "move") {
          const recipe = this.app.store.getById(recipeId);
          const ok = await global.RecipeAsk.ask(
            `Move “${recipe ? recipe.name : "this recipe"}” to “${where}”? ` +
              "It leaves this book for everyone who shares it.",
            { confirmLabel: "Move", danger: true }
          );
          if (!ok) return;
        }

        try {
          if (verb === "move") {
            await this.sync.moveRecipe(recipeId, btn.dataset.target);
            // The copy in the other book carries an id of its own, so this
            // id really is finished here — and a tombstone is what tells
            // the other members of this book, instead of their caches
            // pushing the recipe back (006).
            this.app.store.remove(recipeId);
            this.app.render();
            this.app.toast(`Moved to “${where}”.`);
          } else {
            const { photoCopied } = await this.sync.copyRecipe(recipeId, btn.dataset.target);
            const missing = !photoCopied && this.app.store.getById(recipeId).imagePath;
            this.app.toast(
              missing ? `Copied to “${where}”, without its photo.` : `Copied to “${where}”.`
            );
          }
        } catch (err) {
          console.warn(`Recipe Friend: could not ${verb} recipe.`, err);
          this.app.toast(verb === "move" ? "Couldn't move that recipe." : "Couldn't copy that recipe.");
        }
      });
    }

    /**
     * Everything about who else is in a book: invites, members, and the
     * two ways a book ends for you — leaving it, or deleting it.
     */
    wireSharing() {
      const memberList = $("#member-list");
      if (memberList) {
        memberList.addEventListener("change", async (event) => {
          const pick = event.target.closest && event.target.closest("[data-role-for]");
          if (!pick) return;
          const userId = pick.dataset.roleFor;
          const who = this.members.find((m) => m.userId === userId);
          try {
            await this.api.setMemberRole(this.sync.bookId, userId, pick.value);
            await this.refresh();
            this.app.toast(
              pick.value === "viewer"
                ? `${who ? who.name : "They"} can now read this book, not change it.`
                : `${who ? who.name : "They"} can now add and edit here.`
            );
          } catch (err) {
            console.warn("Recipe Friend: could not change that role.", err);
            this.app.toast("Couldn't change what they can do.");
            await this.refresh();
          }
        });
      }

      $("#invite-btn").addEventListener("click", async () => {
        const out = $("#invite-out");
        try {
          const roleEl = $("#invite-role");
          const role = roleEl && roleEl.value === "viewer" ? "viewer" : "editor";
          const code = await this.api.createInvite(this.sync.bookId, 1, role);
          const url = `${location.origin}${location.pathname}#join=${code}`;
          out.hidden = false;
          out.textContent = url;
          await this.refresh();
          const what = role === "viewer" ? "to read" : "to add and edit";
          try {
            await navigator.clipboard.writeText(url);
            this.app.toast(`Invite link copied — one person, 48 hours, ${what}.`);
          } catch {
            this.app.toast("Invite link ready — copy it from below.");
          }
        } catch (err) {
          console.warn("Recipe Friend: could not create invite.", err);
          this.app.toast("Couldn't create an invite link.");
        }
      });

      $("#invite-list").addEventListener("click", async (event) => {
        const btn = event.target.closest("[data-revoke]");
        if (!btn) return;
        const ok = await RecipeAsk.ask(
          "Revoke this invite link? Anyone still holding it won't be able to join.",
          { confirmLabel: "Revoke", danger: true }
        );
        if (!ok) return;
        try {
          await this.api.revokeInvite(btn.dataset.revoke);
          const out = $("#invite-out");
          if (out && out.textContent.endsWith(btn.dataset.revoke)) {
            out.hidden = true;
            out.textContent = "";
          }
          await this.refresh();
          this.app.toast("Invite revoked.");
        } catch (err) {
          console.warn("Recipe Friend: could not revoke invite.", err);
          this.app.toast("Couldn't revoke that link.");
        }
      });

      $("#member-list").addEventListener("click", async (event) => {
        const btn = event.target.closest("[data-remove]");
        if (!btn) return;
        const ok = await RecipeAsk.ask("Remove this person from the book?", {
          confirmLabel: "Remove",
          danger: true,
        });
        if (!ok) return;
        try {
          await this.api.removeMember(this.sync.bookId, btn.dataset.remove);
          await this.refresh();
        } catch (err) {
          console.warn("Recipe Friend: could not remove member.", err);
          this.app.toast("Couldn't remove that person.");
        }
      });

      $("#delete-book-btn").addEventListener("click", async () => {
        const current = this.currentBook();
        if (!current || !current.isOwner) return;
        if (this.books.length < 2) {
          this.app.toast("This is your only book — create another one first.");
          return;
        }
        // Spell out exactly what is about to be destroyed, for everyone.
        let recipeCount = null;
        try {
          recipeCount = await this.api.countRecipes(current.id);
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
        // Export is the way out offered here, so be straight about what
        // it carries: photos stay behind in the book (J10.4).
        parts.push(
          "This cannot be undone — export first if you want a copy. " +
            "An export carries recipes, not photos."
        );
        const ok = await RecipeAsk.ask(parts.join("\n\n"), {
          confirmLabel: "Delete book",
          danger: true,
        });
        if (!ok) return;

        try {
          await this.api.deleteBook(current.id);
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
        if (!current || current.isOwner) return;
        const ok = await RecipeAsk.ask(
          `Leave “${current.name}”? Its recipes stay with the book.`,
          { confirmLabel: "Leave", danger: true }
        );
        if (!ok) return;
        try {
          await this.api.leaveBook(current.id);
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
            await this.api.renameBook(bookId, name);
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
    /**
     * The book picker, for either verb. Copy is everyone's — it takes
     * nothing from anyone. Move is the owner's, because it takes the
     * recipe out of a book other people are reading (J7.10).
     */
    openMove(recipeId, verb = "copy") {
      const others = this.writableBooks().filter((b) => b.id !== this.sync.bookId);
      if (others.length === 0) {
        this.app.toast(
          verb === "move"
            ? "Create another book first, then you can move recipes into it."
            : "Create another book first, then you can copy recipes into it."
        );
        return;
      }
      this.transferVerb = verb;
      $("#move-title").textContent = verb === "move" ? "Move recipe" : "Copy recipe";
      $("#move-intro").textContent =
        verb === "move"
          ? "Choose where this recipe should live. It leaves this book."
          : "Choose which book to put a copy in. This one keeps its own.";
      this.movingId = recipeId;
      $("#move-list").innerHTML = others
        .map(
          (b) => `
        <li class="book-item">
          <button type="button" class="book-pick" data-target="${esc(b.id)}">${esc(b.name)}</button>
          <span class="book-role">${b.isOwner ? "yours" : "shared"}</span>
        </li>`
        )
        .join("");
      $("#move-dialog").showModal();
    }

    /**
     * Redeem an invite code from a #join= link — but only ever after the
     * person holding it has said yes.
     *
     * Following a link is not consent. Joining a book means everything you
     * save afterwards lands in someone else's collection, where they can
     * read, edit and delete it, so the invite is described in full — which
     * book, whose, and what it costs — before anything is redeemed. The
     * preview runs server-side because the code alone grants no read
     * access to the book yet.
     */
    async join(code) {
      let preview;
      try {
        preview = await this.api.previewInvite(code);
      } catch (err) {
        console.warn("Recipe Friend: could not read that invite.", err);
        this.app.toast("That invite link is invalid, used up, or has expired.");
        return false;
      }

      if (preview.alreadyMember) {
        const ok = await RecipeAsk.ask(
          `You're already in “${preview.bookName}”.\n\n` +
            "Switch to it now? Recipes you save will go into that book until you switch back.",
          { confirmLabel: "Switch" }
        );
        if (!ok) return false;
        // Redeeming again is a no-op for an existing member — the server
        // hands back the book without spending a use — and it is the only
        // thing that knows which book the code points at.
        const book = await this.api.redeemInvite(code);
        await this.refresh();
        await this.switchTo(book.id);
        return true;
      }

      const asViewer = preview.role === "viewer";
      const ok = await RecipeAsk.ask(
        `Join “${preview.bookName}”?\n\n` +
          `${preview.ownerName} is sharing this recipe book with you.\n\n` +
          (asViewer
            ? "You'll be able to see everything in it and copy recipes into " +
              "books of your own, but not change anything here.\n\n"
            : "You'll be able to see everything in it, and everyone in the book — " +
              "including you — can add, edit and delete its recipes.\n\n") +
          "Recipe Friend will switch to this book, so new recipes you save " +
          "will go into it until you switch back.",
        { confirmLabel: "Join" }
      );
      if (!ok) {
        this.app.toast("Invite declined — nothing was joined.");
        return false;
      }

      try {
        const book = await this.api.redeemInvite(code);
        await this.refresh();
        await this.switchTo(book.id);
        this.app.toast(`Joined “${book.name}”.`);
        return true;
      } catch (err) {
        console.warn("Recipe Friend: could not join book.", err);
        this.app.toast("That invite link is invalid, used up, or has expired.");
        return false;
      }
    }
  }

  global.RecipeBooks = { BooksUI, rememberSelection, rememberedSelection };
})(window);
