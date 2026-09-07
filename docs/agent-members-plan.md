# Plan: agent members

A book owner can invite an **agent** — a program, not a person — into a book,
name it, and hand it a credential. The agent reads the book, adds recipes,
and works on the plan. It cannot edit or delete anything, and it is revoked
from the same list that revokes people.

This document is the plan, not the record. The criteria in §2 move into
`docs/journeys.md` as J16 once they are agreed; nothing here is decided
until they do.

## Why

The recipes and the planning history are the interesting half of a meal
assistant, and there is currently no way to reach them except as a person
with a Google account. The two workarounds both cost something real: a
service account with a made-up email address puts a fiction in the member
list, and a hand-signed JWT puts a signing key on somebody's laptop and
makes the app's own security model something you work around rather than
through.

An agent is not a new kind of authority. It is a member with a narrower
role, and it authenticates with a key instead of a Google account —
which the app already has a word for: *"An invite link is a key, not an
announcement"* (J7.4).

## 1. The credential

**The credential is a Supabase refresh token**, belonging to an emailless
anonymous Supabase user that represents the agent.

**Supabase Auth generates it.** The owner's browser calls
`signInAnonymously()`; Supabase creates the user and returns a session.
Nothing is minted locally and no email exists to be fictional.

The dialog packs four things into one string to paste — project URL,
publishable key, book id, refresh token — and shows it once. The agent
presents it with `setSession()`. From then on Supabase rotates the token:
each refresh returns a new one and the agent stores the replacement, so
the string the owner pasted stops working after its first use.

Three properties this leans on, all documented by Supabase:

- Anonymous users are **never** cleaned up automatically. Their docs say
  so under a heading called "Automatic cleanup"; the 30-day delete query
  on that page is one they suggest you write, not one they run.
- Refresh tokens never expire, but are single-use and rotate. Reusing one
  outside a ten-second window revokes the whole session.
- `auth.admin.createUser()` cannot create a user with neither email nor
  phone — so anonymous sign-in is the only supported route to an
  emailless principal, and the fictional email was never avoidable by
  that path.

### Why losing it is cheap

No content row in this schema records who created it. `recipes`,
`live_plans` and `plans` carry a `book_id` and no author; the only rows
tied to the agent's `auth.uid()` are its own `profiles` row and its
`book_members` row, both of which the owner controls from the dialog.

So the usual objection to this design — that a lost token orphans
everything the identity owned — does not apply. Recovery is: revoke the
dead agent, add a new one, paste the new credential. It costs a gesture,
not data. This is a consequence of a decision the schema already made,
and it is what makes the design cheap for this app in particular.

## 2. Draft criteria (to become J16)

Someone wants a program — a meal-planning assistant — to read their book
and help with the week's plan.

1. **An agent is a member, not an account.** It holds a row in
   `book_members` with the role `agent`, so every read policy that
   already exists governs it unchanged. It is not a person and has no
   email address.
2. **Only an owner may add one**, from the Sharing list, and it is named
   at that moment. The name is what the member list shows.
3. **An agent may read the book, add recipes, and work on the plan.** It
   may not edit or delete a recipe, move one, invite anyone, change a
   role, or touch the book itself. Narrower than an editor (J7.3) and
   wider than a viewer (J7.17).
4. **The credential is shown once**, when the agent is created, and never
   again. Losing it means revoking the agent and adding another; the app
   says so at the moment it shows the credential rather than leaving it
   to be discovered.
5. **An agent appears in the member list by name, like anyone else**
   (J7.18), marked as an agent, with the same × that removes a person.
   Removing it is immediate and total: the membership row goes and every
   policy stops matching.
6. **An agent's role cannot be changed to editor or viewer**, and a
   person's cannot be changed to agent. The roster offers no such
   control. An agent that should be something else is removed and
   replaced — a role change would silently hand a program a credential
   that was scoped for something narrower.
7. **A credential does not expire.** An invite is short-lived because it
   is in transit (J7.4); this one lives in a configuration file and is
   revoked rather than waited out. Recorded as a deliberate difference.
8. **An agent gets no photos.** The Storage policies are left alone, so
   a stored photo is not readable by an agent and a recipe it adds
   carries no picture. Nothing in the planning journeys needs one.
9. **What an agent writes is validated exactly as a paste is** (J5.7):
   a recipe missing a name, an ingredient or a step is refused, and
   nothing about being a program relaxes that.

### Boundaries to record

- An agent is per book. One credential does not reach a second book, and
  an agent in two books is two agents.
- Read-only is not confidential, and neither is this: an agent can export
  everything it can read (J7.17's third bullet applies unchanged).
- The app hiding a control is a courtesy; the database is the gate.

## 3. Open decisions

Both need answering before the migration is written. Neither is settled
by this document.

**A. May an agent record a finished plan?** This decides whether
`plans INSERT` gains an agent branch. The recommendation is **no**: Done
is what records that a week was planned (J14.1, J14.5), and it is the
history an agent reads to suggest the next rota. An agent that can write
that history can invent its own evidence. Adding meals and settling lines
is the useful part; Done stays a person's.

**B. Accept enabling anonymous sign-ins project-wide?** It is a project
toggle, not a per-call option. It opens `/signup` to anonymous user
creation at 30 requests per hour per IP — not customisable — and Supabase
recommend a CAPTCHA or Turnstile because the endpoint can otherwise be
used to inflate the database. This is the price of the feature and it is
paid by the whole project, so it belongs in J11 or the boundaries rather
than being absorbed silently.

## 4. Migration 008

One file, run after 007, in the same shape as the others: the reasoning
first, then a checklist of what a reviewer verifies by hand, then the SQL.

**The role.** Widen the check constraint on `book_members.role` to include
`agent`, and add the predicate every write policy will consult:

```sql
create or replace function public.is_book_agent(b uuid)
returns boolean language sql stable security definer
set search_path = public, pg_temp as $$
  select exists (
    select 1 from book_members
    where book_id = b and user_id = auth.uid() and role = 'agent'
  );
$$;
revoke execute on function public.is_book_agent(uuid) from anon;
grant  execute on function public.is_book_agent(uuid) to authenticated;
```

**Reads need no change at all.** `is_book_member` reads `book_members` and
`auth.uid()` and nothing else, so a membership row is the whole of it.

**Writes**, amended one at a time:

| Policy | Change |
| --- | --- |
| `editor recipes insert` | `or is_book_agent(book_id)` |
| `editor recipes update` | unchanged — an agent cannot edit |
| `editor recipes delete` | unchanged — an agent cannot delete |
| `editor live plan insert` | `or is_book_agent(book_id)` |
| `editor live plan update` | `or is_book_agent(book_id)` |
| `editor live plan delete` | unchanged |
| `editor plans insert` | decision A |
| `editor plans delete` | unchanged — Undo stays a person's |
| the three photo policies | unchanged — J16.8 |

**Adding one.** `book_members` has no INSERT path for this: migration 005
deliberately left only "join a book you own", because the policy that
allowed more was how somebody could be conscripted into a book they never
agreed to. So creating an agent is a `security definer` function, and it
carries the two checks that keep 005's hole closed:

```sql
create or replace function public.add_agent(book uuid, agent_id uuid)
returns void language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  if not is_book_owner(book) then
    raise exception 'only the owner of a book may add an agent to it';
  end if;
  if not exists (select 1 from auth.users
                 where id = agent_id and is_anonymous is true) then
    raise exception 'an agent is not a person''s account';
  end if;
  insert into book_members (book_id, user_id, role)
    values (book, agent_id, 'agent')
    on conflict do nothing;
end; $$;
```

The `is_anonymous` check is the load-bearing one. An anonymous user is by
definition nobody's account, so adding one to a book you own cannot
conscript a real person — which is the property that lets this be an
INSERT path at all.

**The role-change door stays shut.** `"owner sets a member's role"` already
constrains the new role to `editor` or `viewer`; leaving it alone is what
implements J16.6, so this migration must not widen it. The
`book_members_role_only` trigger continues to stop the subject of a row
being rewritten.

**A trap to write down in the file.** If an anonymous-user cleanup job is
ever added — Supabase's own docs suggest the query — it will delete every
agent, because an agent is exactly `is_anonymous is true` and old. The
guard needs no admin key:

```sql
and id not in (select user_id from book_members)
```

### What a reviewer checks by hand

The database is outside the test net, as the journeys record, so this
follows 007's precedent:

- a. As an **agent**: select from `recipes`, `live_plans` and `plans` for
     its book returns rows. Insert into `recipes` succeeds. Update and
     delete on `recipes` are refused. Insert and update on `live_plans`
     succeed.
- b. As an **agent**, against a book it is not in: everything returns
     nothing and every write is refused.
- c. As an **agent**: reading `storage.objects` for its book returns
     nothing (J16.8).
- d. `add_agent` called by a non-owner raises. Called with a *permanent*
     user's id raises — this is the 005 property and the most important
     line in the file.
- e. The roster `update` still refuses `role = 'agent'` (J16.6).
- f. Deleting the agent's `book_members` row immediately stops every read
     and write above.
- g. Signed out: unchanged, nothing.

## 5. Client changes

Small, and almost all in one dialog.

**`index.html`** — an Agents block in the books dialog, beside the invite
row: a name field, an "Add an agent" button, a one-shot credential
readout, and a list. About fifteen lines, mirroring the invite markup
already there.

**`js/api.js`** — `createAgent(bookId, name)`, `listAgents(bookId)`,
`removeAgent(bookId, userId)`. `createAgent` is the only interesting one:
it builds a second Supabase client with `persistSession: false` and its
own `storageKey` so the owner's session is untouched, calls
`signInAnonymously({ options: { data: { name } } })`, calls `add_agent`,
and returns the session's refresh token to be shown once.

Passing the name as sign-up metadata is what makes it appear in the
roster: `handle_new_user` already reads `raw_user_meta_data ->> 'name'`
into `profiles.display_name`, and migration 002 already lets co-members
read each other's names.

**`js/books.js`** — `renderAgents`, and wiring for add and remove. The
existing `renderInvites` is 33 lines and this is the same shape.

**`js/sync.js`** — `canWrite` gains `agent`. Note that `canEdit` and
`canWrite` both treat an unknown role as read-only already, so a client
that has not been updated sees an agent as a viewer rather than as an
editor. Nothing widens by accident.

**`handle_new_user`** — an early return for an anonymous user, so an
agent gets a profile row and its name but not a book of its own.

### Two things that will bite

- **The roster's role `<select>` offers only editor and viewer**
  (`js/books.js:216`). An agent row would render showing "Can add and
  edit" and silently demote on change. It needs its own branch: name, an
  agent marker, remove, and no select. This is J16.6 on screen.
- **Pin the book id into the credential.** `resolveBook` prefers a book
  the session *owns* over one it merely belongs to. With the early return
  above an agent owns nothing, so this is belt and braces — but an agent
  that ever acquires a book of its own would otherwise sync that one
  silently.

## 6. Tests

`test/books.test.js`, in the existing style — each name quoting a
criterion. The stub DOM reaches all of this because it is markup and
behaviour rather than layout:

- J16.2 — only an owner sees the add-an-agent control.
- J16.4 — the credential is rendered once and is gone after a refresh.
- J16.5 — an agent appears in the member list by name, marked as an agent.
- J16.6 — an agent row renders no role select; a person's offers no agent
  option.
- J16.9 — an agent's recipe goes through `sanitizeRecipe` like any other.
- `canWrite` and `canEdit` agree about the `agent` role.

What tests cannot reach, to be added to the list at the end of the
journeys: everything in §4. The policies, `add_agent`, and the
`is_anonymous` check are the security model, and they are verified by
hand.

## 7. Not in this repo

The agent itself. The MCP server that consumes this credential is a
separate concern and a separate package; what belongs here is the
credential, the role, and the policies that hold it to them.

Worth knowing while designing this, though: the app's data layer already
runs headless. `plan.js`, `shoplist.js`, `search.js`, `scale.js`,
`units.js` and `share.js` touch no DOM, and `storage.js`, `planstore.js`
and `sync.js` touch only `localStorage`, which a small file-backed shim
satisfies — `test/helpers/load.js` already does exactly this. An agent
built on those modules computes the same shopping list the phone shows,
because it is the same code.
