# User journeys and acceptance criteria

What Recipe Friend is meant to do, written from the outside in. Each journey
is what somebody is trying to achieve; the numbered criteria under it are
the behaviour that has to hold. They are phrased to be checkable, so a test
name can quote one directly, and a second person testing the app can
disagree with the criterion rather than with a bug report.

Where a criterion records a deliberate limitation, it says so. Anything not
written here has not been decided, and code that happens to do something
particular is not by itself a decision.

Terms: a **book** is a named collection of recipes with one owner and any
number of members. Every recipe belongs to exactly one book. Signed in, the
browser's copy of a book is a cache; the server is the shared truth.

---

## J1 · Arriving for the first time

Someone opens the site having never used it.

1. Signed out, the app shows a sign-in screen and no recipes, controls or
   navigation.
2. The only way in is Sign in with Google. There is no email or password
   option.
3. Signing in for the first time creates a profile and one book named after
   the person — "Dave's recipes".
4. A new account has **no recipes at all**. Nothing is seeded.
5. The sign-in screen links to the privacy policy and terms.
6. Local-only use without an account is **not** supported. (The app falls
   back to it only when `js/config.js` has no project configured, which is a
   development case, not a user-facing one.)

## J2 · Writing a recipe down

Someone types in a recipe from their head or a book.

1. A recipe needs a name, at least one ingredient and at least one step.
   Anything short of that cannot be saved.
2. Ingredients are entered as three separate fields — amount, unit, item —
   never as a sentence to be parsed.
3. Leaving the amount empty means "to taste"; the line is kept and is not
   scaled.
4. Amounts accept decimals and common fractions (`1.5`, `½`). Zero is not a
   quantity and is treated as empty.
5. Servings, prep and cook minutes are optional, and empty stays empty
   rather than becoming 0.
6. Tags are free text, lowercased, and become filter chips.
7. A photo can be taken from the device or given as a public URL. Device
   photos are downscaled in the browser (max 1200px, JPEG quality 0.78)
   before they go anywhere.
8. Signed in, a device photo is uploaded to private storage and the recipe
   keeps only its path. If the upload fails the photo stays on the recipe as
   data instead — a photo is never silently lost.
9. **Typed work is not thrown away by accident.** Dismissing the editor by
   tapping outside it or pressing Escape asks first, and only when
   something has actually been typed or changed — opening a recipe, reading
   it and leaving stays a single tap. **Cancel** is an explicit choice and
   closes without asking.
10. **Deleting a saved recipe asks first**, names the recipe, and says it
    cannot be undone. Answering no leaves it exactly where it was.
11. **The editor has an address too, so Back closes it rather than the
    app.** The recipe view got one first (J4.17), which taught people
    that Back closes what is open — and made it worse that from the
    editor it still walked out of the site, taking whatever had been
    typed with it and asking nothing, since a navigation is not a
    dismissal. Back is now a dismissal like any other and gets the same
    question as Escape (J2.9); answering "keep editing" puts the entry
    back, so Back still means Back next time. Editing a recipe stacks on
    top of reading it, so Back from the editor returns to the recipe
    rather than all the way out to the list. Deleting the recipe you were
    editing leaves nothing to go back to, and the address stops naming
    it rather than offering a way to reopen what is gone.

## J3 · Finding something to cook

1. Search matches across names, descriptions, ingredients and tags. An
   ingredient matches **both as written and as you see it**, so a recipe
   stored in grams is findable by "oz" by someone reading in ounces. This
   keeps search aligned with the screen now that units are converted for
   display (J4.4) rather than stored; it does mean two people in one book
   can get different results for the same query.
2. Tag chips and the Favourites filter narrow the list, and combine with
   search.
3. A search can be a list: separate terms with commas and recipes are
   ranked by how many they match, best first, each card naming which ones
   matched. A recipe matching none of the terms is not shown. One term
   ranks nothing — everything shown matches it — so the collection keeps
   its own order.
4. Matching tolerates simple plurals, so "tomatoes" finds "tomato purée".
5. **Search covers the current book only.** Switching books changes what is
   searchable. This is deliberate: each book keeps its own cache, and a
   cross-book result would be ambiguous about where it lives.
6. Favourites are **a property of the recipe, not of the person**. In a
   shared book, one member starring a recipe stars it for everyone. This is
   deliberate — a household's shortlist is shared like the recipes are.

## J4 · Cooking from a recipe

1. Opening a recipe shows ingredients and steps in reading order.
2. The Portions stepper rescales amounts on the fly, using kitchen-friendly
   fractions — halving "1½ tbsp" gives "¾ tbsp".
3. Scaling is display-only. The saved recipe never changes, and closing the
   recipe forgets the scale.
4. Amounts are shown in the reader's preferred units, converted when the
   recipe is displayed rather than when it is saved.
5. Two people sharing a book can hold different unit preferences and neither
   rewrites the other's data.
6. Teaspoons and tablespoons are never converted, and an unrecognised unit
   ("clove", "pinch", "can") passes through untouched while still scaling.
7. An amount renders as the nearest kitchen fraction when it is within 0.03
   of one — so 2.67 shows as "2⅔", not "2.7" — and as one decimal place
   otherwise.
8. **An amount below 0.05 renders as "0".** Scaling a recipe down far
   enough therefore shows "0 tsp" for an ingredient that is present: a
   recipe serving 12, taken to one serving, renders ½ tsp that way. This is
   accepted rather than worked around — below a twentieth of a unit there is
   nothing useful to say, and the recipe as written is always one tap away
   at full portions.
9. **Cook mode** keeps the screen awake while a recipe is open, so a phone
   propped against the bread bin does not lock halfway through. It is a
   toggle in the recipe view and it is **off until asked for** — a screen
   that never sleeps is a battery decision, not one to make for someone.
10. It is let go when the recipe closes, however it closes — the ×,
    Escape, Back, handing over to the editor, or the backdrop where there
    is one to click. (Full screen there is not: the recipe covers the
    viewport on a phone in either orientation, so the backdrop is a way
    out only on the sizes that keep a margin.) A phone that goes back in
    a pocket still awake is the failure this criterion exists to prevent.
11. It survives a glance away. Browsers drop a wake lock whenever the page
    is hidden, so looking at a text message would otherwise end it silently
    for the rest of the cook; it is taken again on returning.
12. The choice is remembered **on the device, not on the profile**. Unlike
    measurement preferences (J8.2), which follow the person, keeping a
    screen awake is about the phone propped in front of you — the laptop
    you typed the recipe on should not inherit it.
13. Where the browser cannot keep the screen awake, the control is not
    shown at all rather than offered and doing nothing.
14. Cook mode is never a reason a recipe fails to open. If the screen lock
    cannot be taken — an unsupported browser, a refusal, a low battery —
    the recipe still opens and the toggle simply reports that it is off.
15. **The recipe takes the whole screen where the screen is small or
    short.** A centred card spends height on a margin and a backdrop, and
    a phone has none to spare: measured on a 375×667 phone, the card
    showed the Ingredients heading and no ingredients. Either dimension
    being tight — narrow, or short because the phone is on its side —
    earns the full screen. Wide, tall screens keep the card.
16. **Where there is width to spare, each list runs into two columns —
    but the ingredients still sit above the steps.** A phone on its side
    is short, not narrow, and a second column is what makes that shape
    usable at all; a tablet held upright is neither, and one column
    already reads well there.

    The width goes inside each list rather than between the two.
    Ingredients beside steps was tried first, with the ingredients held
    sticky, and it fails the thing this view is for: you get the top half
    of the shopping beside the top half of the method, the two halves
    scroll independently of each other, and neither list is ever
    finished. Stacked, there is one thread to follow and one scroll to
    follow it with — all of the ingredients, then all of the method.
    No item is ever split across a column break.
17. **An open recipe has an address.** Full-screen, it reads as a page,
    and a page is left with the Back button — which on a bare dialog
    walks out of the app, mid-cook. So opening one pushes
    `#recipe=<id>`: Back closes the recipe, a reload comes back to it,
    and closing it takes the entry with it. An address naming a recipe
    that is not here opens nothing and keeps the fragment, because signed
    in it may simply not have synced down yet.
18. The Portions stepper sits with the ingredients it changes, under the
    Ingredients heading rather than above it. Above, it read as being
    about the recipe; the only things it changes are in the list below it.
19. **The controls fit one row on a phone.** Favourite and Edit belong to
    this recipe, so they run on inline from the last word of its title,
    and Close — an ×, about the screen rather than the recipe — sits
    opposite them. None of the three takes a row of its own: on a phone a
    row of chrome is a row of ingredients nobody can see. What is left at
    the foot of the view is reached for mid-cook and is **worded, not
    drawn** — a glyph nobody recognises is a control nobody presses, so
    Share says "Share". Favourite and Edit are the exception the title
    line earns: a star and a pencil next to a recipe's name are read
    without a caption, and each carries its accessible name anyway. Their
    hit areas are 44px whatever size the glyph is drawn at.

    Being inline, the pair can be pushed to the next line by a title that
    happens to end near the edge — measured at 8% of widths between 320px
    and 1200px across a range of title lengths. That is accepted: the
    alternative tried was a flex row, which parks them against the right
    margin of a wrapped title, level with the last line but nowhere near
    it, and "after the title" stops meaning anything.
20. **Deleting is done from the editor, not from the recipe you are
    reading.** By the time the editor is open you have said you mean to
    change this recipe, which the screen you cook from has not; and there
    is nothing to delete until there is something saved, so a new recipe
    and one still under review from a link do not offer it. Deleting
    still asks first and names the recipe (J2.10).
21. **Opening a recipe says which recipe opened.** Focus goes to the
    heading, not to whichever control happens to be first in the markup —
    which was the portions stepper, and then the favourite star, neither
    of which names what has just filled the screen.
22. **The page behind is held still.** A modal dialog makes the page
    inert but leaves it scrollable: on a wide screen, turning the wheel
    over the backdrop scrolled the list behind the open recipe by 500px,
    so closing it left you somewhere you never chose to be. The lock goes
    on the root element, because that is what scrolls — a rule on the
    body alone does nothing.
23. **Saving is the one filled button in the app.** With Edit reduced to
    a glyph on the title line, the recipe view has no primary action to
    compete with it, and the editor's Save keeps that weight at the foot
    of the form. Its label stays on one line at every width: down to
    360px the bar holds all three controls on one row, and below that
    Save takes a row of its own rather than being shrunk or broken in
    half.

## J5 · Bringing in a recipe from outside

Covers a share link someone sent, and a recipe an assistant wrote out.

1. Opening a share link shows the recipe in the edit form, titled **Review
   recipe**, so it can be renamed or corrected before it is saved. Nothing
   is stored until it is confirmed.
2. A recipe keeps its identity through that review, so opening the same link
   twice updates the existing recipe instead of adding a second.

   **That identity is one this book gives it, not the sender's.** A recipe
   id is a primary key across every book on the server, so two books
   cannot hold the same one; a copy saved under the sender's id claims
   their row, and the next sync drags the original out of their book and
   into yours. (Where the sender is a stranger, the row is not yours to
   claim at all, and the recipe simply never reaches the server.) So an
   arriving recipe is stored under a fresh id, with the sender's kept
   beside it as `sharedFrom` — which is what a second opening of the same
   link matches on, and what J5.3 names the replacement from.
3. When the recipe is already in the box, the form shows the sender's
   version and says **by name** which recipe saving would replace. Naming it
   matters: "your copy" leaves someone guessing which of their recipes is
   about to be overwritten.
4. A link that cannot be decoded says so rather than failing silently.
5. Opening a share link while signed out holds the recipe across the sign-in
   round trip and reviews it afterwards.
6. **Get help from AI** provides a prompt for a chatbot which asks for the
   recipe as JSON, plus a `#paste` link back to the app.
7. **Paste a recipe** accepts that JSON bare, inside a code fence, or with
   the assistant's chatter around it. A share link pasted there works too.
8. A pasted recipe that the app cannot use explains which rule it breaks —
   it is never dropped in silence.
9. `#paste` opens the paste box directly, and survives the sign-in round
   trip the same way a share link does.
10. Assistants are asked for JSON rather than a link **because most cannot
    run code**, and a chatbot asked for an encoded link will invent a
    plausible one that opens nothing.

## J6 · Sharing a recipe out

1. Share copies a link that carries the whole recipe compressed in the URL
   fragment, so no server ever receives it.
2. **Photos are left out of share links.** Stored photos are private to
   their book and a link cannot carry that; a public `http(s)` image URL on
   the recipe does travel.
3. Anyone holding the link has the recipe. The link is the data.
4. A link points only at this app's own origin, and the decoder refuses an
   oversized payload rather than unpacking whatever it is handed.
5. A share link carries the recipe, not your relationship to it: a recipe
   arriving from a link is never already starred.
6. There is no multi-recipe share link, by choice.

## J7 · Cooking together: books and membership

1. Everyone's first book is named after them and can be shared as it is.
   There is no separate "personal" tier to migrate out of.
2. Anyone can create more books, and switch between them from the header.
3. Everyone in a book can add, edit and delete its recipes.
4. An owner can invite others with a link. A link is **good for one person
   and expires after 48 hours**, and the owner can see the live ones and
   revoke any that went astray.
5. Opening an invite never joins anyone to anything by itself. The app names
   the book and its owner, says plainly that everyone in a book can edit and
   delete its recipes, and waits to be accepted. Membership is something you
   agree to, not something you can be given.
6. A member can leave a book; its recipes stay with the book.
7. An owner cannot leave a book. Their exits are to keep it or to delete it.
8. An owner can delete a book, which destroys its recipes for every member.
   The confirmation states how many recipes and how many other people are
   affected first, and — because it points at Export as the way to keep a
   copy — that an export carries recipes and not photos.
9. Nobody can delete their last remaining book — there would be nowhere for
   new recipes to go.
10. A recipe can be moved to another book you belong to. It keeps its
   identity, and its photo moves with it so that the new book's members can
   see it.
11. A move that doesn't reach the server leaves the recipe exactly where it
    was and says so. A recipe is never dropped locally on the strength of a
    move that didn't happen — including a recipe typed seconds earlier that
    the server has not yet seen, and one whose photo could not be copied
    across.
12. An owner can remove someone from a book. The person removed keeps
    nothing from it; the recipes stay with the book.
13. When a book stops being available to you — its owner deleted it, or
    removed you from it — the app moves you to another of your books and
    forgets the gone book's local copy. It happens on its own, without
    waiting for you to go looking: a sync that starts failing is the symptom
    you actually see, so that is one of the moments it is checked.
14. The message for J7.13 says only that the book is no longer available to
    you. **It must not name a cause**: deletion and removal are
    indistinguishable from the app's side, and guessing means telling
    someone something untrue about a person they cook with.
15. If the book that went was your only one, a replacement is created, named
    after you exactly as your first book was (J1.3).

## J8 · Measurements that suit the cook

1. Weights can be shown as grams/kilograms or ounces/pounds; liquid volumes
   as millilitres/litres or cups/fluid ounces. Either can be left as
   entered.
2. Preferences belong to the person, not the device: signing in elsewhere
   applies the same units.
3. Changing units never edits a recipe.
4. Converted amounts pick their unit by size: grams below 1000 and
   kilograms above, millilitres below 1000 and litres above, ounces below a
   pound, and **fluid ounces below 120ml with cups at or above it** — so
   half a cup and more reads in cups.

## J9 · Working across devices, and offline

1. The browser's copy is the working copy, so the app renders instantly and
   keeps working with no network.
2. Changes sync in the background, coalesced so that rapid edits make one
   round trip rather than many.
3. Where the same recipe was edited in two places, the most recently edited
   version wins.
4. A deletion travels as a tombstone, so a recipe deleted on one device does
   not reappear from another device's cache. Tombstones are kept 180 days.
5. A failed sync retries on the next change, when the tab regains focus, and
   when the network returns.
6. A status line reports Saving… / Syncing… / Synced, and says when sync is
   failing rather than appearing to work.
7. Each book caches separately, so switching books never mixes their
   recipes.

## J10 · Keeping your own copy

1. Export downloads the whole current book as JSON.
2. Import merges a file back in by recipe id, so re-importing the same file
   never creates duplicates.
3. Where a recipe in the file and a recipe in the book share an id, **the
   more recently edited one wins**, matching how two devices reconcile
   (J9.3). A recipe id means the same thing on both paths: an older backup
   never undoes newer work, and a newer backup restores it.
4. **An export carries recipes, not photos.** A stored photo is referenced
   by a path that only members of its book can read, so a recipe imported
   into another account or book arrives without its picture. Photos held on
   the recipe itself — from a public URL, or from a device while signed out
   — do travel.
5. The app says so rather than leaving it to be discovered: exporting a
   book that holds stored photos says they are not included, and the
   delete-a-book confirmation repeats it where it matters most.
6. Import is a bulk operation and does not step through a review of each
   recipe. It is your own backup coming home.

## J11 · Keeping the lights on

1. The site is static and deploys to GitHub Pages on every push to `main`.
2. A daily workflow pings Supabase so the free project does not pause after
   7 days of inactivity. It reads the project URL and publishable key from
   `js/config.js`; no repository secret is involved.
3. That job fails loudly if Supabase does not answer, which doubles as an
   uptime check.
4. There is deliberately no automated backup job: it would need a key that
   bypasses row-level security, in a public repository.
5. The `service_role` key is never used by the app and never committed.

---

## Boundaries

Things that are true on purpose, recorded so they are not "fixed" by
accident:

- Signed-out local use is not a supported journey (J1.6).
- Search does not span books (J3.5).
- Favourites are shared within a book, not personal (J3.6).
- Owners cannot leave their own books (J7.7).
- Invite links are single-use and short-lived, and joining needs consent
  (J7.4, J7.5). This replaced an earlier decision to leave them reusable for
  seven days.
- Share links never carry photos (J6.2), and exports do not either (J10.4).
- There is no multi-recipe share link (J6.6).
- The app cannot tell a deleted book from one you were removed from, and
  does not pretend otherwise (J7.14).
- Amounts below 0.05 display as 0 (J4.8).
- Cook mode is remembered per device, not per person (J4.12).
- Search results depend on the reader's unit preferences (J3.1).
- A recipe's address (J4.17) carries an id and no recipe data. It opens
  something only for someone who already has that recipe, so it is a
  bookmark, not a second kind of share link (J6.6 still holds).
- The recipe view keeps its full preamble — kicker, title, description,
  meta and tags — above the ingredients on every screen. On the shortest
  ones that is still most of the first screenful. Shrinking it was
  considered and deliberately deferred: what it costs is measured in the
  note below, so the next person to look does not have to measure it
  again.

## What the tests cover, and what they do not

`test/` covers the client-side JavaScript: the modules that decide what a
recipe is, what it says on screen, and what survives a round trip. Those
are the failures that would be silent — a recipe quietly losing its tags is
worse than a page that will not load.

Nine of the 99 criteria have no test naming them. Five more things the
tests do not reach, recorded so the gap is visible:

- **The 48-hour lifetime and single use of an invite** are the database's,
  not the app's (J7.4). The client asks only for links that have not
  expired, mints them for one person, and says so on screen; nothing
  client-side stops an expired one.
- **The profile and first book a new account gets** are made by a database
  trigger (J1.3). Only the client's fallback — naming a book after someone
  when their account arrives with none — is held by a test.
- **The resampling and JPEG encoding behind a device photo** are the
  browser's canvas, not ours (J2.7). The tests check the size and quality
  the app asks for; that the result is a smaller, readable JPEG is taken on
  trust.
- **Deployment and the keepalive ping** (J11) are a static host and two
  workflow files. There is no code to exercise, and J5.10 records a reason
  for a decision rather than a behaviour.
- **What the recipe view looks like at a given size** (J4.15, J4.16,
  J4.19, J4.23) is media queries and inline flow, and the stub DOM has no
  layout: it has no viewport, so it cannot be asked what fits on one.
  J4.17, J4.18, J4.20, J4.21, J4.22 and J2.11 are behaviour and markup and
  are held by tests; the rest was measured in a real browser instead, and
  the numbers are below so a regression has something to be a regression
  from.

  Opening this recipe — 11 ingredients, 8 steps, a three-line title —
  and counting what is on screen before any scrolling:

  | Viewport | Ingredients visible | Steps | Action bar |
  |---|---|---|---|
  | iPhone SE 375×667 | 0 → **3** | 0 | 197px, 3 rows → **85px, 1 row** |
  | iPhone 14 393×852 | 0 → **7** | 0 | 197px → **85px** |
  | Phone landscape 852×393 | 0 → 0 | 0 → 0 | 104px → **93px** |
  | Narrow 320×568 | 0 → 0 | 0 | 197px → **85px** |
  | iPad mini 744×1133 | 10 → **11** | 0 → **2** | 104px → **93px** |
  | iPad mini 1133×744 | 3 → **10** | 0 | 104px → **93px** |
  | Desktop 1440×900 | 7 → **11** | 0 → **2** | 104px → **93px** |

  On the two wide entries the steps count is the intended trade, not a
  loss: with the lists stacked (J4.16) the method sits below a complete
  ingredient list rather than beside half of one. Reading the whole of
  what you need to fetch, in one pass, is what those screens are for.

  Two entries still read zero, and both are the deferred preamble rather
  than the layout: at 320×568 and at 852×393 the kicker, title,
  description, meta and tags come to more than the screen has, so the
  first ingredient starts below the fold however much room the view
  itself gives back.

**The database is deliberately outside the net.** The row-level security
policies, `redeem_invite`, `preview_invite` and the Storage rules are the
security model, and none of them are tested: doing so needs a live Postgres
that CI has not got. They are verified by hand in the Supabase dashboard
when a migration is applied. This is the largest untested surface in the
project and is written down here so it stays visible rather than being
mistaken for coverage.
