/**
 * books.js — recipe books, members, invite links (M3), and agents (J16).
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

  // --- agents' keys and how to use them (J16.13, J16.14) -----------------

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /** "18 Oct 2026": a date nobody has to know the locale to read. */
  function shortDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }

  /**
   * How long ago, in the words somebody would use. The database writes
   * last_used_at at most once a minute, so nothing finer is true.
   */
  function sinceWhen(iso, now = Date.now()) {
    const then = new Date(iso).getTime();
    if (!iso || Number.isNaN(then)) return "";
    const mins = Math.floor((now - then) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
    return `on ${shortDate(iso)}`;
  }

  /**
   * What to paste into a client to reach this book (J16.14), one entry
   * per choice in #agent-client. Built from the page's own origin, since
   * the hosted server is always beside the site (Caddy routes /mcp), and
   * from the key that was just made — so it exists only while the key
   * does, and is never stored.
   *
   * Claude Desktop is not named: its own config file starts local
   * programs and has no place for a remote server's header, so claiming
   * it here would be a config that does nothing.
   */
  function connectionConfigs(url, key) {
    const auth = `Bearer ${key}`;
    const json = (value) => JSON.stringify(value, null, 2);
    return {
      "claude-code": {
        hint: "Run this in a terminal. Add --scope user to have it in every project.",
        text: `claude mcp add --transport http recipe-friend ${url} --header "Authorization: ${auth}"`,
      },
      json: {
        hint: "For clients that read an mcpServers file — Cursor\u2019s mcp.json, a " +
          "project\u2019s .mcp.json. Merge it with any servers already there.",
        text: json({
          mcpServers: {
            "recipe-friend": { type: "http", url, headers: { Authorization: auth } },
          },
        }),
      },
      openclaw: {
        hint: "Put this under mcp.servers.recipe-friend in OpenClaw\u2019s config.",
        text: json({ url, transport: "streamable-http", headers: { Authorization: auth } }),
      },
      plain: {
        hint: "For any client that speaks MCP over HTTP. The last line checks it from " +
          "a terminal: it should list the tools.",
        text: [
          `URL     ${url}`,
          `Header  Authorization: ${auth}`,
          "",
          `curl -s ${url} -H "Authorization: ${auth}" ` +
            `-H "Content-Type: application/json" ` +
            `-H "Accept: application/json, text/event-stream" ` +
            `-d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
        ].join("\n"),
      },
    };
  }

  /**
   * Put text on the clipboard and say so where the eye already is. A
   * refused clipboard is not a lost key: the text is still on screen and
   * selectable, so that is what is said, rather than a failure somebody
   * can do nothing about.
   */
  async function copyAndSay(text, said) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      if (said) said.textContent = "Copied.";
    } catch (err) {
      console.warn("Recipe Friend: could not reach the clipboard.", err);
      if (said) said.textContent = "Couldn't copy — select it and copy by hand.";
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
      this.agents = [];
      // The key just made and nothing else: held only while the panel
      // that shows it is open, so the connection settings can be redrawn
      // for another client without reading a secret back out of the page.
      this.revealed = null;
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
    /**
     * May this book be written to at all, by anybody holding this
     * session? Wider than `canEdit`, which answers the different question
     * of whether to draw the controls: an agent writes (J16.3) and is
     * still shown the read-only screen, because nothing an agent runs
     * opens this dialog and a person who did should not be offered
     * buttons the database would refuse.
     */
    canWriteTo(book) {
      return this.canEdit(book) || Boolean(book && book.role === "agent");
    }

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
        this.membersFailed = false;
      } catch (err) {
        // An empty roster and an unreadable one look identical on screen,
        // and one of them is a bug. Say which this is (J7.18): a book you
        // share with somebody, reporting nobody, is how a broken query
        // went unnoticed here for months.
        console.warn("Recipe Friend: could not load members.", err);
        this.members = [];
        this.membersFailed = true;
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
      // The agents list is the owner's too (list_agents refuses anyone
      // else), but unlike invites a failure here is never the normal
      // case, so it says so rather than drawing an empty list (J16.13).
      if (current && current.isOwner) {
        try {
          this.agents = await this.api.listAgents(current.id);
          this.agentsFailed = false;
        } catch (err) {
          console.warn("Recipe Friend: could not load agents.", err);
          this.agents = [];
          this.agentsFailed = true;
        }
      } else {
        this.agents = [];
        this.agentsFailed = false;
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
      if (memberList && this.membersFailed) {
        memberList.innerHTML =
          '<li class="member-item member-trouble">Couldn\u2019t load who is in this book. ' +
          "Check your connection and open Books again.</li>";
      } else if (memberList) {
        memberList.innerHTML = this.members
          .map(
            (m) => `
          <li class="member-item">
            <span class="member-name">${esc(m.name)}${m.isMe ? " (you)" : ""}</span>
            ${
              m.role === "agent"
                ? // An agent is in the list like anybody else (J16.7), and
                  // wears a marker rather than a control: what it may do
                  // cannot be changed, to it or from it (J16.8). Offered a
                  // select here it would have rendered as "Can add and
                  // edit" — the first option, since it is not "viewer" —
                  // and the next change would have silently widened a
                  // credential handed over for something narrower.
                  `<span class="agent-badge">agent</span>`
                : iOwn && !m.isMe
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

      // Agents are the owner's to hand out and take back (J16.2), so the
      // whole block goes rather than being shown disabled — a control
      // that is not yours to press reads better absent than greyed.
      const agents = $("#agents-section");
      if (agents) agents.hidden = !iOwn;
      // A key belongs to the moment it was made (J16.6), and this is
      // every moment after it. Keyed on the book it was minted for, it
      // survived closing and reopening the dialog on the same book —
      // which is the thing somebody actually does, and which made "it is
      // not shown again" false where it was easiest to disprove. It is
      // forgotten unless this very render is the one that drew it.
      if (!this.credentialJustShown) this.forgetKey();
      this.credentialJustShown = false;

      this.renderInvites(iOwn);
      this.renderAgents(iOwn);
    }

    /**
     * The book's agents, for its owner (J16.13): what each is called, the
     * start of its key so two can be told apart, when it was added and
     * when it was last used. A key nobody has used in months is the one
     * worth asking about.
     */
    renderAgents(iOwn) {
      const list = $("#agent-list");
      const empty = $("#agent-empty");
      if (!list) return;
      if (!iOwn) {
        list.innerHTML = "";
        if (empty) empty.hidden = true;
        return;
      }
      if (this.agentsFailed) {
        list.innerHTML =
          '<li class="member-item member-trouble">Couldn\u2019t load this book\u2019s agents. ' +
          "Check your connection and open Books again.</li>";
        if (empty) empty.hidden = true;
        return;
      }
      if (empty) empty.hidden = this.agents.length > 0;
      list.innerHTML = this.agents
        .map((a) => {
          const used = a.lastUsedAt ? `used ${sinceWhen(a.lastUsedAt)}` : "never used";
          const added = shortDate(a.createdAt);
          return `
        <li class="member-item agent-item">
          <span class="agent-who">
            <span class="member-name">${esc(a.name)}</span>
            <span class="agent-meta"><code class="invite-code">${esc(a.keyPrefix || "")}…</code>
              ${added ? `· added ${esc(added)} ` : ""}· ${esc(used)}</span>
          </span>
          <button type="button" class="member-remove" data-agent-remove="${esc(a.userId)}"
                  aria-label="Remove agent ${esc(a.name)}" title="Remove agent">×</button>
        </li>`;
        })
        .join("");
    }

    /**
     * Draw the one-time panel for a key just made: the key, and the
     * settings for whichever client is picked (J16.14). Text only, never
     * markup — the key and the URL are the two things that vary.
     */
    showKey(key) {
      this.revealed = { key };
      const out = $("#agent-out");
      const secret = $("#agent-secret");
      if (!out || !secret) return;
      secret.textContent = key;
      const said = $("#agent-copied");
      if (said) said.textContent = "";
      this.renderClientConfig();
      out.hidden = false;
      // Where a screen reader lands is the first thing it says, and the
      // warning and the key are what it should say.
      const copy = $("#agent-copy-btn");
      if (copy) copy.focus();
    }

    /** The settings for the client picked in #agent-client. */
    renderClientConfig() {
      const pre = $("#agent-config");
      const hint = $("#agent-client-hint");
      const said = $("#agent-config-copied");
      if (said) said.textContent = "";
      if (!this.revealed) {
        if (pre) pre.textContent = "";
        if (hint) hint.textContent = "";
        return;
      }
      const pick = $("#agent-client");
      const configs = connectionConfigs(`${location.origin}/mcp`, this.revealed.key);
      const chosen = configs[pick && pick.value] || configs["claude-code"];
      if (pre) pre.textContent = chosen.text;
      if (hint) hint.textContent = chosen.hint;
    }

    /**
     * Put the key down: out of memory and out of the page. Closing the
     * dialog, pressing Hide key, and every later render all come here, so
     * the key is on screen for exactly as long as the panel is open.
     */
    forgetKey() {
      this.revealed = null;
      const out = $("#agent-out");
      if (out) out.hidden = true;
      for (const id of ["#agent-secret", "#agent-config", "#agent-client-hint",
        "#agent-copied", "#agent-config-copied"]) {
        const el = $(id);
        if (el) el.textContent = "";
      }
    }

    /**
     * Remove an agent, having asked (J16.7). The same question whichever
     * list the × was pressed in, and it says the two things that are true
     * of no other removal: it is immediate, and the key does not come
     * back.
     */
    async removeAgentAsked(userId) {
      const who = this.agents.find((a) => a.userId === userId) ||
        this.members.find((m) => m.userId === userId);
      const name = who ? who.name : "this agent";
      const ok = await RecipeAsk.ask(
        `Remove ${name} from the book? Its key stops working straight away and for good — ` +
          "to connect it again, add a new agent and use the new key.",
        { confirmLabel: "Remove", danger: true }
      );
      if (!ok) return;
      try {
        // The membership row is the whole of it: the database takes the
        // key and the account with it (J16.7).
        await this.api.removeAgent(this.sync.bookId, userId);
        await this.refresh();
        this.app.toast(`${name} can no longer see this book.`);
      } catch (err) {
        console.warn("Recipe Friend: could not remove agent.", err);
        this.app.toast("Couldn't remove that agent.");
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
      // Three answers, not two: a viewer pushes nothing, an agent pushes
      // only what the server has never seen, everyone else pushes
      // everything (J16.3).
      this.sync.setBook(bookId, {
        readOnly: !this.canWriteTo(book),
        addOnly: Boolean(book && book.role === "agent"),
      });
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
      // However the dialog closes — the button, Escape, a tap outside —
      // an agent's key goes with it (J16.6).
      this.dialog.addEventListener("close", () => this.forgetKey());
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
        // The same × takes an agent out (J16.7), and the question has to
        // know which it is asking about: "this person" over a program is
        // the kind of wrong wording that makes somebody answer no.
        const who = this.members.find((m) => m.userId === btn.dataset.remove);
        if (who && who.role === "agent") {
          await this.removeAgentAsked(who.userId);
          return;
        }
        const ok = await RecipeAsk.ask("Remove this person from the book?", {
          confirmLabel: "Remove",
          danger: true,
        });
        if (!ok) return;
        try {
          // A person keeps the account they signed in with; only an
          // agent's goes with its membership.
          await this.api.removeMember(this.sync.bookId, btn.dataset.remove);
          await this.refresh();
        } catch (err) {
          console.warn("Recipe Friend: could not remove member.", err);
          this.app.toast("Couldn't remove that person.");
        }
      });

      // --- agents (J16) ---------------------------------------------------

      const agentList = $("#agent-list");
      if (agentList) {
        agentList.addEventListener("click", async (event) => {
          const btn = event.target.closest("[data-agent-remove]");
          if (btn) await this.removeAgentAsked(btn.dataset.agentRemove);
        });
      }

      const copyBtn = $("#agent-copy-btn");
      if (copyBtn) {
        copyBtn.addEventListener("click", () =>
          copyAndSay(this.revealed && this.revealed.key, $("#agent-copied")));
      }
      const configCopy = $("#agent-config-copy-btn");
      if (configCopy) {
        configCopy.addEventListener("click", () => {
          const pre = $("#agent-config");
          return copyAndSay(this.revealed && pre && pre.textContent, $("#agent-config-copied"));
        });
      }
      const clientPick = $("#agent-client");
      if (clientPick) clientPick.addEventListener("change", () => this.renderClientConfig());
      const done = $("#agent-done-btn");
      if (done) {
        done.addEventListener("click", () => {
          this.forgetKey();
          const name = $("#new-agent-name");
          if (name) name.focus();
        });
      }

      const agentName = $("#new-agent-name");
      const addAgent = $("#create-agent-btn");
      if (addAgent) {
        addAgent.addEventListener("click", async () => {
          const name = (agentName && agentName.value.trim()) || "";
          if (!name) {
            this.app.toast("Give the agent a name first.");
            if (agentName) agentName.focus();
            return;
          }
          try {
            const agent = await this.api.createAgent(this.sync.bookId, name);
            // Shown first, copied on purpose. This is a password in all
            // but name and it is shown exactly once (J16.6), so it does
            // not go onto the clipboard by itself — but making somebody
            // select 47 characters by hand, in a dialog, on a phone, is
            // how a key gets half-copied and pasted broken. The buttons
            // are the answer; the warning above them is still the point.
            if (agentName) agentName.value = "";
            // Before the refresh below, which is what redraws the dialog
            // and would otherwise forget the key it is about to show.
            this.credentialJustShown = true;
            this.showKey(agent.key);
            // The agent exists and its key is on screen, so a refresh
            // that fails now must not report a failure to create it —
            // the list being stale is a smaller thing than telling
            // somebody their key is worthless while it is in front of
            // them.
            try {
              await this.refresh();
            } catch (err) {
              console.warn("Recipe Friend: the agent was added but the list is stale.", err);
            }
            this.app.toast(`${agent.name} can now read this book.`);
          } catch (err) {
            console.warn("Recipe Friend: could not add an agent.", err);
            // The server's sentence ("only the owner…", "a book can have
            // at most 20 agents") is the useful part. "Couldn't add that
            // agent" alone tells somebody nothing they did not know.
            this.app.toast(
              err && err.message
                ? `Couldn't add that agent — ${err.message}`
                : "Couldn't add that agent."
            );
          }
        });
      }

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
          // Drop this book's local cache so it doesn't linger on the
          // device. `useBook(null)` only pointed the cache somewhere else
          // and said it dropped it: the book's recipes stayed in local
          // storage under their own key, and after J12 its plan would
          // have stayed there with them. Leaving is J7.13's situation
          // arrived at deliberately, so it takes J7.13's path — which
          // announces the book, and is what carries the plan away too
          // (J12.2, J12.3).
          this.app.store.forgetBook(current.id);
          this.books = this.books.filter((b) => b.id !== current.id);
          const next = this.books[0];
          if (next) {
            this.sync.setBook(next.id);
            this.app.store.useBook(next.id);
            rememberSelection(this.sync.userId, next.id);
            await this.sync.syncNow();
          } else {
            // Nothing of the book we walked out of is left pointed at, so
            // the cache goes back to the keyless one it had before there
            // was a book (the same place deleting your last book leaves
            // it).
            this.app.store.useBook(null);
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

  global.RecipeBooks = {
    BooksUI,
    rememberSelection,
    rememberedSelection,
    connectionConfigs,
    sinceWhen,
  };
})(window);
