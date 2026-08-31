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
6. Tags are free text, lowercased, kept once however many times they are
   typed, and are what the Filter menu is made of (J15.1). They were
   filter chips, one per tag, until there were enough of them to be a
   wall (J15.2). Keeping each only once is what lets a tag be counted:
   lowercasing is what manufactures the duplicate — "Vegan" and "vegan"
   typed on one recipe are one word by the time they are stored — and a
   tag counted twice makes the menu promise a longer list than the tap
   gives (J15.4).
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
2. Tags and the Favourites filter narrow the list, and combine with
   search. **Tags are chosen from a menu and combine as "both"** (J15.1,
   J15.3); Favourites stays a chip in the toolbar (J15.9). What is
   currently on shows beneath, and only that (J15.2).
3. A search can be a list: separate terms with commas and recipes are
   ranked by how many they match, best first, each card naming which ones
   matched. A recipe matching none of the terms is not shown. One term
   ranks nothing — everything shown matches it — so the collection keeps
   its own order. **A sort chosen by name takes precedence over this
   ranking** (J15.7), which then decides only between recipes the sort
   has tied.
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

    **And the photo takes a column there rather than a band.** The
    measurement above was made on a recipe with no photo, and the full
    screen fixed it only for that recipe: with a photo the picture is 3:2
    across the whole width, which is 223px on that phone, and it sits
    above a three-line title, a description, the particulars and the tags
    — so the first ingredient landed at 709px on a 667px screen and the
    view showed the heading and nothing under it all over again. Capping
    the picture's height does not reach: it still owns a whole line of
    the page, and even a 133px band leaves the first ingredient behind
    the action bar. So on a phone, and on any screen short enough to be
    full-bleed for the reason above, the photo takes 40% of the measure
    and the description sits beside it. Nothing is hidden or clipped to
    buy that: the description keeps all of its words, the photo keeps its
    ratio, and the first ingredient comes up to 513px. A screen with the
    height to spend — a tablet held upright — keeps the full-width
    photograph, capped at three tenths of the screen so that it can never
    again be the whole of the first screenful.
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
3. Everyone in a book who may write to it can add, edit and delete its
   recipes (J7.17). Membership alone no longer means write access.
4. An owner can invite others with a link. A link is **good for one person
   and expires after 48 hours**, and the owner can see the live ones and
   revoke any that went astray.
5. Opening an invite never joins anyone to anything by itself. The app names
   the book and its owner, says plainly what this particular invite grants —
   adding and editing alongside everyone else, or reading and copying out
   and nothing more (J7.17) — and waits to be accepted. Membership is
   something you agree to, not something you can be given.
6. A member can leave a book; its recipes stay with the book.
7. An owner cannot leave a book. Their exits are to keep it or to delete it.
8. An owner can delete a book, which destroys its recipes for every member.
   The confirmation states how many recipes and how many other people are
   affected first, and — because it points at Export as the way to keep a
   copy — that an export carries recipes and not photos.
9. Nobody can delete their last remaining book — there would be nowhere for
   new recipes to go.
10. **Moving a recipe to another book is the owner's.** It takes the
    recipe out of a book other people are reading, so the owner of the
    book it is leaving is the one who may do it, it asks first, and it
    names what goes where. The photo goes with it so the new book's
    members can see it.

    **A recipe belongs to the book it was created in, so a move is a copy
    under a new id and a tombstone left behind.** It cannot be the same
    row: an id is a primary key across every book, and rewriting one
    row's book was what let a recipe be dragged between books by an
    ordinary push (J5.2). It also left the other members of the old book
    holding a recipe the server no longer had there, which their next
    sync pushed straight back. The tombstone is what tells them, and it
    is only honest because the id really is finished — the copy carries
    its own.

    Note the limit rather than overstating it: an editor can still copy a
    recipe and delete the original, because editors may delete (J7.3).
    Making moving the owner's makes it deliberate, not impossible.
11. A move that doesn't reach the server leaves the recipe exactly where it
    was and says so. A recipe is never dropped locally on the strength of a
    move that didn't happen — including a recipe typed seconds earlier that
    the server has not yet seen, and one whose photo could not be copied
    across. Nothing is tombstoned on the strength of a refusal, and no
    photo is filed in the other book before the original is known to be
    there to tombstone.
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
16. **Anyone in a book can copy one of its recipes into a book they can
    write to.** Copy takes nothing from anybody, which is what makes it
    everyone's where moving (J7.10) is the owner's — and what will make a
    book you can only read still worth being in.

    A copy is a new recipe: its own id, its own photo filed under that
    id, and unstarred, because a copy carries the recipe and not your
    relationship to it (J6.5). It records no trail back to where it came
    from — the book it came from may later be deleted, or you may be
    removed from it, and an attribution that outlives its subject is
    worse than none.

    It does not ask, because it takes nothing. A recipe still inside the
    push debounce can be copied, since a copy is built from what is in
    front of you rather than from a row that may not be up yet. A photo
    that cannot be brought across costs the photo and says so, not the
    copy — nothing is at risk, unlike a move.
17. **A book can be one you read and do not change.** An owner chooses
    when they invite — the link says which it is, and the person opening
    it is told before they accept (J7.5) — and can change it afterwards
    from the member list. There was no way to change a role at all
    before: the column existed, no policy consulted it, and no UPDATE
    policy allowed writing to it.

    Ownership is not a rung on that ladder. It stays on the book, where
    every existing policy already reads it.

    Three things follow, and are worth saying out loud:

    - **A viewer's client never pushes.** Row-level security would refuse
      it, and a refused push parks the status line on "Sync paused — will
      retry" for ever, which makes read-only look broken rather than
      restricted. It pulls as normal: reading is the point.
    - **A viewer cannot favourite.** A favourite is a property of the
      recipe, not of the person (J3.6), so starring is a write like any
      other. That is the price of the shared shortlist, and it is
      deliberate.
    - **Read-only is not confidential.** A viewer sees everything and can
      Export it or copy it out (J7.16). It means they cannot change your
      book, not that they cannot keep what is in it — and a role taken
      back does not retrieve what somebody already has.

    The controls that write are not offered where they would fail, but
    the database is the gate: the app hiding a button is a courtesy, not
    a boundary.

18. **The Sharing list says who is in this book, by name, including
    you** — and an owner changes what each of them may do from that same
    list. A roster that cannot be read says so rather than rendering as
    an empty book: the two look identical on screen, and one of them is a
    bug. This one was. `listMembers` asked PostgREST to embed
    `profiles(display_name)` from `book_members`, which it cannot do —
    there is no foreign key between those tables, both point at
    `auth.users` instead — so the query failed, the failure was swallowed,
    and a shared book reported nobody in it. Names are fetched separately
    now, and are a courtesy on top of the roster: a member whose profile
    cannot be read is still listed, as "Someone".

    The control for what a *new* invite grants is a separate thing from
    the roster, and is labelled and placed so it cannot be mistaken for
    one of its rows.

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

## J12 · Planning a week

Someone picks several recipes, at the portions they mean to cook them at,
so the app can tell them what to buy.

1. **A plan is a bag of meals, not a calendar.** Recipes go in with the
   portions wanted; nothing is assigned to a day, a slot or a date. The
   shop does not care which night the curry is, and neither does the
   question the plan exists to answer.
2. **A plan belongs to the book, the way its recipes and its favourites
   do** (J3.6). One household, one plan: whoever does the shop sees what
   whoever planned it chose. There is one live plan per book, and it needs
   no name and no date — it is "the plan".
3. Each book keeps its own plan in its own local cache, exactly as each
   book keeps its own recipes (J9.7). Switching books switches plans.
4. **Planning is a mode over the list, not a screen of its own.** Turning
   it on leaves search, tag chips, Favourites and the "chicken, rice"
   ranking (J3) working as they are, and gives every card a way in and a
   portions stepper. Choosing between recipes is what the list is already
   for. **Its control is a toggle and looks like one** — pressed, wearing
   the same treatment as cook mode (J4.9) — and is named for the thing it
   turns on: "Plan" on its own read as a place to go, when what it does is
   put you in a mode you will want to come back out of.

   **The stepper is there before anything is planned**, showing what the
   next add will use, so portions are chosen up front rather than
   corrected afterwards. It appeared only once a meal existed, which
   changed the row's shape under a thumb already reaching for it and spent
   the row's height either way. Adding takes whatever it shows, so a
   second night goes in at the portions on screen rather than back at the
   recipe's own.

   **An empty plan says what to do about it** — "Nothing in the plan yet
   — add recipes below" — rather than counting nothing. A bar that reads
   "0 meals" is arithmetic where a sentence was wanted.
5. Portions default to the recipe's own servings and step the way the
   recipe view steps them (J4.2) — one serving at a time where servings
   are known, half a batch where they are not. The plan holds the
   portions; **the recipe is never edited** (J4.3). Once a recipe has a
   meal the stepper steers the most recent one, so there is one control
   with one meaning: the portions this recipe is in the plan at, or is
   about to go in at. **The number it holds before the first add is not
   kept** — it is not a fact about the book until somebody acts on it, so
   it is never stored, never synced, and leaving plan mode forgets it.
   Two people steering one stepper neither of them can see is not a
   feature.
6. A recipe can be planned more than once — two nights, two entries, its
   own portions each. The list sums them without caring.
7. In plan mode the recipe view gains a way to add what is open. Outside
   plan mode it gains nothing: those controls fit one row on a phone
   (J4.19), and that is not spent on a control for something you are not
   doing.
8. **A recipe that leaves the book leaves the plan.** Deleted, or moved
   out by its owner (J7.10), it goes from the plan with it — a plan is a
   list of things to cook, and a recipe nobody in this book has is not one
   of them. What was already settled against it on the shopping list stays
   settled (J13.12).
9. The plan has an address (`#plan`), so Back closes it the way it closes
   an open recipe (J4.17).
10. **A read-only member cannot plan.** The plan is the book's, so adding
    to it is a write, and a viewer's client never pushes (J7.17) — the
    same rule that stops them favouriting. A viewer gets the recipes and
    no planner. That is the price of the plan being shared, and it is the
    first thing to revisit if plans are ever made personal.
11. **Two people can settle lines at the same time.** Recipes merge whole,
    most recent edit winning (J9.3), because a recipe has one author at a
    time; a shopping list has two people in one aisle. So a plan's settled
    amounts merge **per item**, each carrying when it was settled, and
    each is an amount rather than a step — whoever's write lands last
    still says the right total. The meals in a plan merge whole, like a
    recipe: nobody races to add the curry.
12. The plan works with no network, like the rest of the app (J9.1) — and
    it matters more here than anywhere else, because the supermarket is
    the one building where the phone has no signal.

## J13 · Shopping from a plan

1. The shopping list is every planned recipe's ingredients, scaled to the
   portions planned, summed into one line per thing to buy.
2. **Summing happens in base units and is formatted once, at the end.**
   Formatting first and adding the results loses ingredients: J4.8 renders
   anything below 0.05 as 0, and three lots of "0 tsp" is not none.
3. **A shopping quantity is never rendered as 0.** J4.8 accepts it in a
   recipe, where the recipe as written is one tap away at full portions; a
   shopping list that says "0 g butter" is telling you to buy nothing.
   Below that size the line shows the item without an amount.

   **And a remainder that small is finished.** Settle a kilo of the
   1000.4 g a plan happens to ask for and four tenths of a gram are
   left: the line stayed under "to buy" saying "1000 g sorted" with
   nothing after it, and Copy sent you out for caster sugar you already
   had. Nobody buys a thousandth of an egg, so what cannot be said has
   been dealt with. It takes something having been settled against the
   line first — otherwise a genuine pinch of saffron would mark itself
   bought the moment it appeared, which is the same mistake pointing the
   other way.
4. Lines combine on the item as written, tolerating simple plurals the way
   search does (J3.4). The app already believes "tomatoes" and "tomato"
   are the same word when looking for a recipe; believing it here too is
   one rule rather than two. **Where the recipes spelled it differently
   and the line asks for more than one, the line prints a plural one of
   them wrote** — "6 onions", not "6 onion" because the Bolognese was
   typed in first. The app has never pluralised anything and this does
   not start: every spelling it can print is one somebody typed, and a
   candidate has to be another contributor's word plus an "s" or an "es".
   **Exactly one of a thing asks the same question backwards** and gets
   a singular one of them wrote, so a shortfall of one onion is "1 onion"
   rather than "1 onions" — on screen and in the copy, which are named
   together. Where nobody typed the other spelling the line keeps its
   own, so "1 gooses" stands as written rather than being guessed at, and
   what each recipe wrote is still under the line (J13.7), so the choice
   is visible rather than silent.
5. **Amounts combine only within a unit family.** 400 g tomatoes and 1 tin
   tomatoes are two lines under one heading, because nothing in the app
   knows how big a tin is — the same honesty as J4.6 letting "clove" and
   "pinch" through untouched. Mass combines with mass and volume with
   volume, since those convert; spoons and unrecognised units combine only
   with the same unit as written, since those do not (J4.6). Three
   teaspoons and a tablespoon are two lines, and that is the same decision
   as the tin.
6. Amounts are shown in the reader's preferred units (J8), so two people
   in one book read one list each their own way. **Where the reader keeps
   units as entered (J8.1) a summed line has no single "as entered" to
   keep**, so it reads in the unit that most of it came from — the largest
   contributor's. Someone who writes in cups and asked for no conversion
   must not be handed a list in millilitres; that is the preference they
   expressed, arriving by the back door.
7. Every line says what it is made of — "6 onions · Bolognese 4, Curry 2"
   — so a combination that should not have happened is visible, and one
   that should have is obvious. **Where the recipes wrote the item
   differently, the line says what each of them wrote**: "3 peppers ·
   Bolognese 2 (peppers), Curry 1 (pepper)". Without that this
   criterion is a promise it cannot keep — the plural rule (J13.4) is what
   makes the wrong merge, and naming the recipes it came from does not
   show you that one of them said something else.
8. Lines with no amount ("to taste", J2.3) are grouped at the end and
   never summed. They are things you might be out of, not quantities.
9. **Settling a line records how much of it is settled, not that it is
   done.** ✗ ("we have this") and ✓ ("this is in the basket") both record
   the amount that was on the line when pressed. What is left to buy is
   the difference — so planning another recipe wanting two more onions
   brings two onions back, without disturbing the three already settled.
10. **A part-settled line shows both numbers, and what is copied is the
    shortfall.** "4 onions · 3 sorted, 1 to get" — the total is what the
    plan asks for and belongs on screen beside what it is made of (J13.7),
    but the only useful thing to take to a shop is what is missing.
    Copying the total would buy four onions to get one, which is the
    mistake the settling was there to prevent. The screen and the copy
    must not disagree about which number is which.
11. A settled amount is never reduced when the requirement falls. Dropping
    a recipe leaves nothing outstanding; putting it back surfaces exactly
    the shortfall again, because what was settled was never forgotten.
12. Settled amounts are held per item, not per recipe, so they survive
    recipes joining and leaving the plan. Removing the recipe that put
    onions on the list does not un-settle onions.
13. **Copy gives what is left**: everything neither removed nor settled,
    one line per item, amount first. A static site has no supermarket to
    talk to (J11), so pasting into the shopping app of your choice is the
    interop — and copying twice must never ask for the same thing twice.
    Where the browser can share, the same text is shared instead.
14. Removed lines are not gone. They collapse into a group that says how
    many, and one tap puts one back: ✗ is a fast gesture, and fast
    gestures are mistyped. **Putting one back retracts that settlement
    whole**, rather than returning some part of the amount — a settlement
    is a quantity (J13.9), but the gesture that made it was one tap and so
    is the gesture that undoes it. The retraction is stamped like any
    other settlement, so it wins the merge (J12.11) rather than being
    quietly undone by an older device.

## J14 · What the plan remembers

1. **Done finishes the plan**, and is the moment a plan is recorded: every
   recipe in it is stamped as planned, the plan is archived, and an empty
   one takes its place.
2. Done happens by itself when the last outstanding line is settled — you
   have just said you are finished by settling it, so it does not also
   ask. It says what it did and offers Undo. Settling the last line with ✗
   counts: a week you already had everything for was still planned.
   **Undo is the one thing here that needs a network.** A finished plan is
   recorded for the whole book, and taking a record back has to reach the
   server or another device will simply hand it back. It says so rather
   than appearing to work, which is the exception J12.12's offline promise
   has to carry.
3. Finishing needs at least one recipe. An empty plan has nothing to
   record and offers no Done.
4. **Clear discards a plan without recording it.** A week that never
   happened should not claim to have been planned.
5. **What is recorded is that a recipe was planned, not that it was
   cooked.** This is a planner, not an oven: a plan finished today may be
   for a fortnight's time, and nothing here can know whether a pan was
   ever used. So the word is always "planned", and the date is the date
   the plan was finished.
6. A recipe's card and its recipe view say when it was last planned, the
   ordinary way of saying it — **"Last planned 3 weeks ago"** — because
   that is the question being asked, not which Tuesday it was. The word
   "last" earns its place: on a line of particulars beside "Serves 4" the
   bare participle reads as a label for the thing rather than an answer
   about it, and it is what says this is the most recent of several
   rather than the only one there ever was.
7. **A recipe that has never been planned says nothing.** "Never planned"
   reads as a reproach on a recipe typed in five minutes ago. It still
   sorts where it matters (J14.9).
8. A recipe in the live plan says "In the plan" instead, which is more use
   than a date while you are deciding, and stops it being added twice by
   accident. **Both sit on the line of particulars** — after "Serves 4 ·
   45 min" — in italic, rather than taking a row of their own. A card's
   rows are the scarcest thing it has and three words were spending one
   of them; and what the plan has to say about a recipe is a particular
   like the others, so it belongs where they are. Where a recipe has no
   particulars to give, the note is the line.

   **A card no longer counts its ingredients.** Moving the note onto that
   line saved nothing while it did: measured on a card, the line simply
   wrapped, and a wrapped line costs what the separate row cost — 37px
   against 36px, which is not a saving. Nobody chooses a dinner by how
   many ingredients it has and it was the longest of the three, so it
   went rather than the note going back. From 375px up the line now
   holds, at 20px; at 320 it still wraps, which is no worse than what it
   replaced.

   **The live one is marked as live**, in the accent the Plan count wears
   in the header, because they are the same fact said in two places. A
   date is history and stays in the colour of the line it joins.
9. **Least recently planned is one of the sorts** (J15.6): least recently
   planned first, never-planned before them. **It orders the list rather
   than narrowing it.** There is no honest threshold for "lately" — a
   fortnight is a lot for a weeknight supper and nothing at all for a
   Sunday roast — and while you are deciding what to cook, hiding the
   recipes you have had recently takes away the comparison you are trying
   to make. It puts the neglected ones under your thumb and leaves
   everything else where it was.

   It was a chip beside Favourites first, which is why this criterion
   once had to say in a paragraph that it sorted rather than filtered:
   there was nothing on the screen to say so. In a menu called Sort there
   is, and the rule about what happens when a listed search is also on
   goes the other way now — the sort wins, and the ranking breaks its
   ties (J15.7).
10. How often a recipe has been planned is counted from the same archive,
    so "most often planned" needs nothing else stored. **Every appearance
    counts**: a recipe planned twice in one plan (J12.6) was planned
    twice, because it is about to be eaten twice. The count is the lesser
    of the two questions — when a recipe was last planned is the one being
    asked (J14.6, J14.9) — but "we seem to have this constantly" deserves
    an answer that matches what actually went on the list.
11. **Nothing about planning is stored on the recipe.** A stamp there
    would bump its `updatedAt`, which reorders the list and would let
    finishing a plan overwrite an edit made on another device (J9.3). The
    archive is the record, and the recipe is left alone.
12. An archived plan keeps the names of the recipes it held, so a recipe
    deleted afterwards does not leave a blank line in what was planned.

## J15 · Choosing what to look at

Someone with a lot of recipes, and a lot of tags on them, wants a shorter
list in an order that answers a question — "which curry have I not had in
ages" being the one this journey is named for.

1. **Filtering and sorting are two different things, and are chosen in two
   menus.** They were one row of chips, which made a sort look like a
   filter and left J14.9 explaining in a paragraph what the screen should
   have shown. A menu each says which is which without a sentence, and
   makes the two combine into one question rather than competing to be
   the answer.
2. **The row beneath them says what is on, not what could be.** Every tag
   in the book was drawn as a chip, so the row grew with the book and
   became a wall before it was a control — it was the menu and the answer
   at the same time, and had to show everything. Choosing moves into the
   menus; the row keeps only what is active, each with a way to take that
   one off, and a way to clear the lot. Nothing on, nothing there, and a
   toolbar quieter than the one it replaces.
3. **Tags combine, and combining them narrows.** Two tags mean both and
   not either: "curry" and "quick" is a shorter list than either alone,
   which is what somebody deciding what to cook means by saying both.
4. **Each tag says how many recipes it accounts for**, which is the thing
   the old row could not say at all. The count is taken against what the
   other filters and the search have already left, not against the whole
   book, so it is not a promise the rest of the toolbar has already
   broken. Precisely, it is **the size of the list with that tag on** —
   which is what a tap gives you while the tag is off, and what you are
   already looking at once it is on. Said as "what the tap would give
   you" it would be a lie about the tags already chosen, where the tap
   takes the tag off and the list gets longer.
5. **A tag that would leave nothing is shown and cannot be chosen**,
   rather than being taken out of the menu. A tag vanishing as you filter
   reads as a book losing things; a tag greyed with a nought beside it
   reads as an answer. **A tag already on is always choosable**, whatever
   its count, because that tap is the way off: a search matching nothing
   takes every count to nought, and locking the tags on at that moment
   traps somebody in an empty list with the door shut.
6. The sorts are **recently added, name A to Z, least recently planned,
   most often planned, and quickest first** — a small closed set, because
   a list of every order a collection could be put in is another wall.
   Recently added is what the list has always done and stays the default.

   **A recipe that lacks what a sort reads goes last**, never first: one
   with no timings is not a claim to be quick, and one never planned is
   not the most often planned. The exception is least recently planned,
   where never planned really is the far end of the scale and sorts
   first (J14.9).
7. **A sort chosen by name outranks the search's own ranking** (J3.3), and
   the ranking becomes the tiebreak within it. This reverses what J14.9
   settled, and the reversal is the point: a chip reading "not planned
   lately" beside a search box is ambiguous about which of them decides
   the order, and picking an order out of a menu called Sort is not.
   Where no sort is chosen, a listed search ranks as it always has.
8. **None of it is remembered.** Search, filters and sort are forgotten on
   reload, and switching books clears them too — a book you have just
   opened showing you a third of itself, for reasons set on a different
   book last week, is a bug that looks like missing recipes. Measurement
   preferences follow the person (J8.2) because they are about how you
   read; these are about what you are doing this minute.
9. **Favourites stays pinned** in the toolbar rather than folding into the
   menu with the tags. It is used more than any tag and is one tap where
   the others are two, and a shortlist you keep on purpose is not the
   same kind of thing as a word you happened to type on a recipe.
10. Where the filters leave nothing, the list says so **and offers to
    clear them**, because the way out of an empty list is the thing you
    cannot see when the list is empty.
11. The menus are used one-handed on a phone like everything else here
    (J4.19): they open to something big enough to hit, and they do not
    push the recipes off the screen while they are open.

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
- **Two tags mean both, never either** (J15.3). An "any of these" filter
  is a different question and answering both from one control would make
  neither legible.
- **What the toolbar is doing is not remembered** (J15.8): no saved
  views, no last-used sort, nothing carried between books. The list you
  open is your whole book.
- **Tag counts are what the other filters have left**, not what the book
  holds (J15.4), so the same tag reads differently depending on what else
  is on. That is the number worth having — but it is the size of the list
  *with that tag on*, not the size of the list a tap would produce, and
  the two differ for a tag already chosen.
- A plan is a bag of meals, not a calendar: nothing in it is assigned to
  a day or a date (J12.1).
- Plans are shared with the book, so a read-only member cannot plan or
  settle a line at all (J12.10).
- The shopping list holds only what the planned recipes ask for. There is
  no free-text item to add "bin bags", no pantry of staples that settles
  itself, and no ordering by aisle — which would need the app to know what
  a supermarket is.
- Nothing carries from one plan to the next. Saying "we have onions" is
  about this shop (J13.9).
- **Two plans are two plans, and the newer one wins whole.** Settlements
  merge per item within a plan (J12.11), but never between one plan and
  the next, or "we have onions" — said about a shop that is over — comes
  back on the following list. **The cost is that work put into the losing
  generation goes with it**: a plan built on a device which has never
  synced this book, a meal added on one phone in the window between
  another phone finishing the plan and this one hearing about it, or one
  of two plans when two devices each start the first plan a book has ever
  had. Both really are plans, and a book has one (J12.2); merging them
  instead would resurrect exactly what clearing a plan is for (J14.4). It
  is not warned about on screen, because the warning would have to appear
  every time two devices meet and would be wrong almost every time.
- **Tolerating plurals when combining (J13.4) merges some things that are
  not the same thing.** "Pepper" and "peppers" are one line, and ground
  pepper and bell peppers are not one shop. The rule earns its place on
  "onion"/"onions", which is the common case by a distance; the wrong
  merges are rare, and J13.7 is what makes each one visible on the line
  rather than silent. Matching more cleverly would need the app to know
  what food is.
- **An export carries recipes, not plans** (J10.1). Planning history lives
  in the book's archived plans and does not survive a restore into a new
  account, in the same way a photo does not (J10.4).
- There is no shareable plan link; J6.6 still holds.
- A shopping quantity is never rendered as 0, though a recipe's is
  (J13.3 against J4.8). The list is the one place where the difference
  between "a very little" and "none" is a wasted trip.
- The recipe view keeps its full preamble — kicker, title, description,
  meta and tags — above the ingredients on every screen. On the shortest
  ones that is still most of the first screenful. Shrinking it was
  considered and deliberately deferred: what it costs is measured in the
  note below, so the next person to look does not have to measure it
  again. What has since been rearranged rather than shrunk is the photo,
  which on a phone sits beside the description instead of above it
  (J4.15) — the words are all still there, and so are the five parts of
  the preamble; two of them simply share a line now.
- **A card is as tall as what is in it**, and a row of cards is not.
  Half a book has a photograph and half has not, and the difference is
  247px in a 330px column; making every card in a row the height of the
  tallest of them put that difference *inside* the shorter cards, as a
  356px hole between a description and its tags. The slack falls between
  the cards instead, where the next row begins. The cost is that the feet
  of a row no longer line up — in plan mode the row of controls each card
  carries can sit up to 350px apart across a row at 1440px — and that is
  accepted: every card has that row while the mode is on, so each is
  drawn at the foot of its own card rather than short of it.
- **Titles across a row of cards are not on one baseline**, because the
  photo sits above the title and a photo-less card has nothing there.
  Reserving the picture's 247px on a card that has no picture was the
  alternative and is worse: it is a hole in the same place, drawn on
  every second card, and it buys a shared baseline with a screenful of
  nothing. Making the photo shorter — 3:2 or 16:9 rather than 4:3 —
  would close most of the offset and is a decision about what a card
  looks like rather than about this defect, so it is left alone.

## What the tests cover, and what they do not

`test/` covers the client-side JavaScript: the modules that decide what a
recipe is, what it says on screen, and what survives a round trip. Those
are the failures that would be silent — a recipe quietly losing its tags is
worse than a page that will not load.

Ten of the 151 criteria have no test naming them — J4.15, J4.16, J4.23,
J5.10, J11.1 to J11.4, J12.12 and J15.11. Six more things the tests do
not reach, recorded so the gap is visible:

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
- **That the plan keeps working with no network** (J12.12) is the local
  cache being the working copy, which J9.1 already holds tests for. There
  is nothing about the planner that makes it truer or less true; it is
  written down because the supermarket is where it matters and a future
  change could break it without breaking anything a test names.
- **What the recipe view looks like at a given size** (J4.15, J4.16,
  J4.23), and **that an open menu covers the list rather than shoving it
  down the page** (J15.11), are media queries and absolute positioning,
  and the stub DOM has no layout: it has no viewport, so it cannot be
  asked what fits on one. J4.17, J4.18, J4.20, J4.21, J4.22 and J2.11 are
  behaviour and markup and are held by tests; the rest was measured in a
  real browser instead, and the numbers are below so a regression has
  something to be a regression from.

  The same blindness hid a live bug for as long as the menus existed.
  The listener that shuts a menu on an outside click ran in the bubble
  phase, and choosing a tag redraws the menu under the thumb — so by the
  time it looked, `contains` was being asked about a button no longer in
  the page, said no, and shut the Filter menu on every single choice, in
  the one menu built for choosing several things in a row (J15.3). It
  listens in the capture phase now. The stub has no event propagation and
  no `contains`, so nothing in `test/` can tell the two apart; it was
  confirmed by tapping two tags in a browser, and confirmed again by
  putting the listener back in the bubble phase, where the menu shuts
  after one.

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

  **What planning cost that table.** The preamble gained a line: a
  recipe in the plan, or one planned before, now says so above the
  ingredients (J14.6, J14.8). Measured the same way — the same eleven
  ingredients, eight steps and three-line title, in Chromium at each
  size with a coarse pointer, which is what makes the bar 93px rather
  than 80px — the line costs 19.8px of preamble and moves two of the
  seven entries:

  | Viewport | Ingredients visible | Steps |
  |---|---|---|
  | Narrow 320×568 | 1 → **0** | 0 |
  | Desktop 1440×900 | 11 | 2 → **0** |

  The other five are unchanged, and no action bar moved: the plan's own
  control in the recipe view (J12.7) is shown only in plan mode and the
  bar still holds one row at 320px. Both entries that moved were already
  the tightest of the seven, and both lose their last line rather than
  their first — which is the shape of the deferred preamble again, not a
  new problem. The line is not paid for anywhere: shrinking the preamble
  stays deferred, and this records what deferring it now costs.

  **What the photograph cost that table, and what it costs now.** The
  table above was measured on a recipe with no photo, which is why it
  reads at all: opened with one, every entry in it was nought. Measured
  again in Chromium at the same seven sizes, with a coarse pointer and a
  phone's overlay scrollbar, on the same fixture — eleven ingredients,
  eight steps, a three-line title at 375px, a description of three lines,
  four tags and the recipe in the plan — and counted against the top of
  the sticky action bar, which is what the content scrolls under, the
  same recipe with and without a photograph:

  | Viewport | Ingredients, no photo | Ingredients, photo | First ingredient, photo |
  |---|---|---|---|
  | Narrow 320×568 | 0 | 0 | 707 → **548** |
  | iPhone SE 375×667 | 2 | 0 → **1** | 709 → **513** |
  | iPhone 14 393×852 | 7 | 1 → **5** | 721 → **513** |
  | Phone landscape 852×393 | 0 | 0 | 903 → **365** |
  | iPad mini 744×1133 | 11 | 4 → **6** | 865 → **757** |
  | iPad mini 1133×744 | 10 | 0 | 1083 → **624** |
  | Desktop 1440×900 | 11 | 0 → **2** | 1094 → **680** |

  Nothing in the no-photo column moved, which is the point: the recipe
  that already read well reads exactly as it did. Every action bar is
  where it was — 85px on the four phone entries, 93px on the three wide
  ones — and no step count changed.

  **Three entries still read nought with a photo**, and each is honest
  about why. At 320×568 and at 852×393 the photo-less recipe reads nought
  too: that is the deferred preamble again, not the picture. At 1133×744
  the picture is capped by the height of a short landscape screen and the
  first ingredient sits at 624px, on the screen but under the action bar
  — 19px of preamble short, which would have to come out of the title,
  the description or the portions stepper, and none of the three is this
  fix's to spend.

  **What the app bar measures.** Signed in, with an account name and a
  book name of ordinary length, at the same seven sizes — the bar itself,
  the top of the first card, and the first recipe's name, which is what
  somebody is actually looking for:

  | Viewport | App bar | First card | First recipe's name |
  |---|---|---|---|
  | Narrow 320×568 | 133.4 → **107.6** | 339.1 → **313.3** | 611.4 → **585.6** |
  | iPhone SE 375×667 | 132.4 → **106.6** | 290.1 → **264.3** | 603.6 → **577.8** |
  | iPhone 14 393×852 | 132.4 → **106.6** | 290.1 → **264.3** | 617.1 → **591.3** |
  | Phone landscape 852×393 | 117.4 → **88** | 296.8 → **267.3** | 647.0 → **617.6** |
  | iPad mini 744×1133 | 117.4 → **88** | 296.8 → **267.3** | 611.0 → **581.6** |
  | iPad mini 1133×744 | 67.4 | 246.8 | 542.0 |
  | Desktop 1440×900 | 65.4 | 229.5 | 524.8 |

  Both themes measure the same at every one of the seven, in the list and
  in the recipe view; nothing here is a colour. In plan mode the bar is
  the same and the first card is 95.6px further down at every size, which
  is the plan's own bar over the list.

  **The bar no longer grows as the window does.** Swept from 320 to 1920
  it was 132.4px up to 520, 88 from 539 to 620, and then **117.4 from 621
  to 744** — a third row appearing as the window widened, because the
  account and the book stopped taking a line of their own and pushed the
  four controls onto one instead. It now falls and never rises: 107.6 at
  320, 106.6 from 360 to 412, 88 from 440 to 744, 86 from 820 to 999, and
  65.4 from 1000 up.

  **One row on a phone was not reachable and here is the arithmetic.**
  The four controls come to 303px at their most compact, the brand mark
  is 36 and the page's own gutters are 40, which is 387px against a 375px
  screen. The bar is therefore two rows below 420px — the mark and, on
  the same line opposite it, the account and the book; the controls
  across the line beneath — and two rows from 420 to 999 in the other
  arrangement, the mark and the controls together with the account and
  the book on the line below. The wordmark beside the mark is what goes
  under 540px, where it is exactly what stops the controls fitting; the
  mark itself stays, and the full masthead is on the sign-in screen where
  there is a screen to give it. Taking a word off a control, or a control
  off the bar, would buy the last row and neither is this fix's to spend.

  **The masthead shares an edge with the page now.** The rule under the
  bar is still full-bleed, but what stands on it begins where the first
  card begins: the brand sat at x=16 on a phone and x=20 at 1440 while
  the columns of recipes started at 20 and 202.5. Measured at every width
  in the sweep, the brand and the grid now start at the same x — 20 up to
  1060, then 32.5 at 1100, 82.5 at 1200, 202.5 at 1440 and 442.5 at 1920.

  **What the plan's own screens measure**, so those have something to
  regress from too. Eleven recipes carrying nine tags between them, five
  of them planned, twenty-four shopping lines, one part-settled and three
  collapsed into "you already have":

  | Viewport | Filter row | Plan action bar | Meal row |
  |---|---|---|---|
  | Narrow 320×568 | 6 rows, 300px → **4 rows, 198px** | 85px, 1 row | broken mid-word → **2 rows** |
  | 360×640 | 4 rows, 198px | 85px, 1 row | name at 104px → **2 rows** |
  | iPhone SE 375×667 | 4 rows, 198px | 85px, 1 row | name at 104px → **2 rows** |
  | iPhone 14 393×852 | 4 rows, 198px | 85px, 1 row | name at 104px → **2 rows** |
  | Phone landscape 852×393 | 2 rows, 65px | 86px, 1 row | 1 row |
  | iPad mini 744×1133 | 2 rows, 95px | 93px, 1 row | 1 row |
  | Desktop 1440×900 | 2 rows, 65px | 86px, 1 row | 1 row |

  The plan's bar carries four controls where the recipe's carries three,
  and it holds one row at every width including 320px, where Clear,
  Copy, Share and Done come to 198px of a 280px row. Nothing in either
  screen is below the 44px floor (J4.19): ✗, ✓, the steppers, ×, "Put
  back" and the summary of the removed group all measure 44px or more at
  every size. Nothing scrolls sideways at any width, including a recipe
  named in sixty characters and an ingredient hyphenated across
  seventy-five. In the dark the quietest text on the shop — the
  struck-through line in the basket, the "sorted / to get" tail, what a
  line is made of, and the removed group's summary — all sit at 5.26:1
  on the dialog's ground, and at 5.4:1 in the light.

  **What the two menus measure.** The Filter row column above measures a
  row that no longer exists: it was every tag in the book drawn as a
  chip, and four rows of it at 198px on a phone is the wall J15.2 was
  written about. What stands there now is three controls — Favourites,
  Filter, Sort — and a row beneath them holding only what is on. Measured
  in Chromium with a coarse pointer and a phone's overlay scrollbars, so
  the row really is 280px wide at 320px as the plan's bar was, on a book
  of 22 recipes carrying 25 tags between them — two of them 39 characters
  long, six of them on one recipe only, four recipes with no timings and
  three with no servings — with Favourites and two tags on:

  | Viewport | Toolbar row | Active row | Filter panel | Sort panel |
  |---|---|---|---|---|
  | Narrow 320×568 | 2 rows, 92px | 2 rows, 92px | 280×341 at x 20–300 | 240×261 at x 60–300 |
  | 360×640 | 1 row, 44px | 2 rows, 92px | 320×352 at x 20–340 | 240×261 at x 100–340 |
  | iPhone SE 375×667 | 1 row, 44px | 2 rows, 92px | 335×352 at x 20–355 | 240×261 at x 115–355 |
  | iPhone 14 393×852 | 1 row, 44px | 2 rows, 92px | 353×352 at x 20–373 | 240×261 at x 133–373 |
  | Phone landscape 852×393 | 1 row, 44px | 1 row, 44px | 240×236 at x 155–395 | 240×236 at x 154–394 |
  | iPad mini 744×1133 | 1 row, 44px | 1 row, 44px | 240×352 at x 155–395 | 240×261 at x 154–394 |
  | Desktop 1440×900 | 1 row, 44px | 1 row, 44px | 240×352 at x 345–585 | 240×261 at x 344–584 |

  **The row was built for two chips and now holds three**, which costs a
  second line at 320 and nowhere else. At full tracking the three come to
  373.6px, and to 396.9px once Filter says how many tags are on — so the
  compaction the bars below use now runs to 440px rather than 380px, and
  brings them to 320.6px, one line from 375 up. At 320 they need 320.6px
  of a 280px row and keep two lines of 44px, which is still less than half
  what the wall of tags took. At 360 the one line survives a single-digit
  count with 1.4px to spare and takes a second line at two digits, which
  means ten tags on at once.

  **Neither panel pushes the list** (J15.11): the first card sits at the
  same y open or shut at every one of the seven — 320.7 at 320×568, 272.7
  at the three taller phones, 246.8 at the three wide ones — and both
  panels paint over the active row rather than reflowing it. (Those three
  absolute numbers were taken before the app bar was compacted and are
  now some 26px lower on a phone and 30px on a tablet — see the app bar's
  own table below. What they were measuring is the difference between
  open and shut, which is still nought.) **Neither
  runs off an edge** now. Hung from its own chip, Filter began 136.5px
  across a 320px screen and ended at 344.5, putting the counts that are
  the point of the menu (J15.4) past the edge and giving the page a 25px
  sideways scroll it has at no other moment; Sort, being the last control
  in the row, hung leftwards from a chip the wrap had returned to the left
  margin and was drawn from x −61.4 at 320 and 360, and −40.9 at 393. On a
  phone both now hang from the row instead — Filter from its left edge and
  the full width of it, Sort from the right at 15rem, which is what its
  five labels need. Nothing scrolls sideways at any width from 320 to 1920,
  with either menu open, a 39-character tag on, and the list empty.

  **Everything is 44px** (J4.19): both summaries, every tag row, every
  sort row, every chip in the active row along with its ×, "Clear filters"
  and the empty list's way out, at all seven sizes in both themes. The 25
  tags come to 1167px of rows in a panel 236 to 352px tall, so it scrolls,
  and a 39-character tag wraps to two lines of 50.2px with its count still
  in the right-hand column. The empty state's message and its way out are
  centred across the grid at every width, and the longest way out — "Clear
  the search and filters" — holds one line at 261.8px of a 280px row.

  In the light, a tag's name reads at 8.71:1 on the panel and its count at
  5.40:1; a tag that is on reads at 15.80:1 with its ✓ at 5.86:1; and a
  tag greyed at nought reads at 5.40:1 — it was 2.23:1 and its nought
  1.90:1 under a flat 45% opacity, which is a row you can see is there and
  cannot read, and J15.5 wants that nought read as an answer. The step
  down is made in the palette now instead. In the dark those are 7.31,
  5.26, 13.22, 5.67 and 5.26:1. An open summary carries its label at
  5.56:1 in the light and 6.10:1 in the dark, and its ▾ — a mark, not text
  — at 3.58 and 3.71:1, against 3.92 and 4.28:1 while it rests.

  **What is left, and left deliberately.** The panel is capped at 60vh, so
  on the shortest screens its foot lands below the fold: 71px of it at
  320×568 and 56.7px at 852×393, reached by scrolling the page a little
  before scrolling the panel. Tying the cap to the space actually below
  the toolbar cannot be said in CSS without a magic number that a wrapped
  toolbar row would falsify, and how much of a short screen a menu may
  take is a decision rather than a defect, so it is written down here
  rather than guessed at.

  The keyboard was the other thing the tests could not see. Every choice
  in either menu rewrites the innerHTML it was made in, which threw away
  the focused button and left the keyboard on the body — after the first
  tag, in the menu built for choosing several (J15.3), and after taking
  anything off the row. Focus now goes back to the equivalent control:
  the same tag's row, the next chip along in the row, the chip that turned
  a filter on once the row has emptied, the Sort chip after a sort, and
  the summary when Escape shuts a menu from inside it. The empty list's
  way out lands in the search box, but only when it was pressed rather
  than tapped — a click synthesised by Enter carries a detail of 0, and a
  thumb should get the recipes back without the on-screen keyboard rising
  over them. Tab to Filter, Enter, Tab, Enter, Tab, Enter now leaves two
  tags ticked, the menu open, and the keyboard on the second tag.

**The database is deliberately outside the net.** The row-level security
policies — including the ones on `live_plans` and `plans`, which are what
stop a read-only member planning (J12.10) — `redeem_invite`,
`preview_invite`, `move_recipe`, the three triggers that make a recipe's
book, a membership row's subject and a plan's book immutable, and the
Storage rules are the security model, and none of them
are tested: doing so needs a live Postgres
that CI has not got. They are verified by hand in the Supabase dashboard
when a migration is applied. This is the largest untested surface in the
project and is written down here so it stays visible rather than being
mistaken for coverage.
