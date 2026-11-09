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
   option. That is a statement about people; a program let into a book by
   its owner gets in another way and never sees this screen (J16).
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
9. **Typed work is not thrown away by accident.** Leaving the editor by
   the breadcrumb or by Back asks first, and only when something has
   actually been typed or changed — opening a recipe, reading it and
   leaving stays a single tap. A crumb is a way to somewhere else, not a
   way of saying the typed work can go, and that holds for the crumb one
   step up as much as the one at the root: climbing back to the recipe
   being edited is still leaving the editor. **Cancel** is the exception,
   because it is the one control that says what it does; it closes
   without asking, and asking after it would be nagging.
10. **Deleting a saved recipe asks first**, names the recipe, and says it
    cannot be undone. Answering no leaves it exactly where it was.
11. **The editor has an address too, so Back closes it rather than the
    app.** The recipe view got one first (J4.17), which taught people
    that Back closes what is open — and made it worse that from the
    editor it still walked out of the site, taking whatever had been
    typed with it and asking nothing, since a navigation is not a
    dismissal. Back is now a dismissal like any other and gets the same
    question as the breadcrumb (J2.9); answering "keep editing" puts the entry
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
10. It is let go when the recipe closes, however it closes — the
    breadcrumb, Back, handing over to the editor, or the ground moving
    under it: signing out, or the book it belongs to going away while it
    is open (J4.24). A phone that goes back in a pocket still awake is
    the failure this criterion exists to prevent.
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
15. **The recipe is a page, and takes the whole screen.** It was a
    centred card over the list, which spent height on a margin and a
    backdrop that a phone has none to spare for: measured on a 375×667
    phone, the card showed the Ingredients heading and no ingredients.
    It is now a view (J4.22) and there is no card at any size — what a
    wide screen buys is measure, not a margin. What is tight, narrow or
    short, buys back the padding instead.
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
    and a page is left with the Back button — which, on a screen the app
    had not given an address, walked out of the app mid-cook. So opening
    one pushes `#recipe=<id>`: Back closes the recipe, a reload comes
    back to it, and closing it takes the entry with it. An address naming
    a recipe that is not here opens nothing and keeps the fragment,
    because signed in it may simply not have synced down yet. A recipe
    restored *from* an address pushed no entry, so closing it has nothing
    to unwind: the address is rewritten to the list rather than going
    back into whatever page the link was followed from (J4.23).
18. The Portions stepper sits with the ingredients it changes, under the
    Ingredients heading rather than above it. Above, it read as being
    about the recipe; the only things it changes are in the list below it.
19. **The controls fit one row on a phone.** Favourite and Edit belong to
    this recipe, so they run on inline from the last word of its title.
    Nothing else is on the row: the way out is the breadcrumb above it
    (J4.23), which is about the screen rather than the recipe. On a phone
    a row of chrome is a row of ingredients nobody can see. What is left at
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
22. **A recipe is a screen you go to, not a box that opens over one.**
    It was a modal dialog, which made the page inert but left it
    scrollable, so the list behind had to be locked still or reaching the
    end of a long method carried on into it. That lock is what made the
    recipe hard to read: panning a zoomed page *is* scrolling it, so
    pinching into an ingredient left the recipe pinned under the thumb,
    the sticky bar at its foot sat at the bottom of a viewport nobody was
    looking at any more, and rotating re-laid-out a scrolling box around
    an offset that no longer meant anything. So the recipe, the plan and
    the editor are sections in the page, shown one at a time; the list,
    the app bar and the footer are hidden rather than covered, which is
    also what takes them out of a screen reader's way now that no dialog
    is making the rest of the page inert. Nothing is held still, because
    there is nothing behind to hold — and coming back puts the list where
    it was left, which a browser does for a page you navigate away from
    and is ours to do inside one document.
23. **A view says where it is, and how to leave.** Each carries a
    breadcrumb, and it is the only navigation on screen — the app bar is
    hidden behind a view, on the same reasoning as J4.19. The trail is
    read off the address rather than the history stack, so a link opened
    cold reads the same as one walked to: the editor sits under the
    recipe it edits either way. The root is the book's name, because that
    is where the recipes actually are. Climbing is closing, so each step
    up unwinds the entry that opened it (J4.17) — and where there is no
    entry underneath, because the screen was restored from a link rather
    than opened from the list, the address is rewritten to the list
    rather than reaching back into somebody else's page. On a phone the
    trail collapses to its last link and nothing else: the whole trail
    wraps at that width, and the heading underneath already says where
    you are.
24. **A view comes off the screen when the ground moves under it.**
    Signing out, or the book a recipe belongs to going away while it is
    open — switching books, leaving one, being removed from one (J7.13)
    — leaves it naming something that is not in the list underneath any
    more. It closes with the book, rather than being left over a sign-in
    form or a book it was never in.
25. **Saving is the one filled button in the app.** With Edit reduced to
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
2. Anyone can create more books, and switch between them from the header
   (Books, or on a phone the book's name, which is the header's title:
   J18.29).
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

   That is a rule about people. An agent is *placed* in a book by its
   owner and agrees to nothing (J16.2), which is only safe because there
   is nobody there to disagree: the identity behind an agent has no
   account, no email and no other book, so placing one takes nothing from
   anyone. Consent is owed to a person, and an agent is not one. Each
   half of that is enforced and not merely intended — an agent cannot be
   added to a second book, and cannot have one of its own (J16.1) — because
   the argument only holds while they are all true.

   **And an invite is still something only a person can accept.** Agents
   were once anonymous accounts (J16), which would otherwise have made
   every invite link redeemable by anybody who held one, with no Google
   account and no trail. Redeeming is closed to anonymous callers and to
   agents for that reason. It is the one place where letting a program
   in reached back and touched a rule about people, and the rule won.
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
   failing rather than appearing to work. On a phone only the failing
   status is shown (J18.29).
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
   by a path that only members of its book can read — bar one kind of
   member, an agent, which cannot (J16.10) — so a recipe imported into
   another account or book arrives without its picture. Photos held on
   the recipe itself — from a public URL, or from a device while signed out
   — do travel.
5. The app says so rather than leaving it to be discovered: exporting a
   book that holds stored photos says they are not included, and the
   delete-a-book confirmation repeats it where it matters most.
6. Import is a bulk operation and does not step through a review of each
   recipe. It is your own backup coming home.

## J11 · Keeping the lights on

1. The site is static and is served from the home server, from the same
   origin as the API, by a checkout of this repository pinned to a commit.
   A push to `main` changes nothing live; bumping the pin does.
2. The server is reached only through a Cloudflare Tunnel, which the server
   dials out to. Nothing on the home network is opened to the internet, and
   nothing in the stack listens on more than the machine's own loopback.
3. Nothing has to be kept awake. The server has no idle clock, so there is
   no ping and no workflow standing in for visitors.
4. There is deliberately no automated backup in this repository. The
   server's data directory is the only server-side copy, and Export (J10)
   is how anybody keeps their own.
5. The `service_role` key is never used by the app and never committed.

## J12 · Planning a week

> Replaced by J18 (build steps 1 and 2 have shipped). The plan's readout,
> its shopping list and plan mode over the recipe list are gone, and a
> book's lists took their place; a recipe reaches one by "Add to list" in
> the recipe view (J18.18). Criteria that have gone keep their numbers,
> so references to them still land somewhere.

Someone picks several recipes, at the portions they mean to cook them at,
and puts them on the shopping list.

1. *Replaced by J18.* The plan as a bag of meals is gone; a recipe goes
   onto a list as an item (J18.18).
2. *Replaced by J18.1.* Lists belong to the book.
3. *Replaced by J18.1 and J18.22.*
4. *Gone* (J18.26). Planning was a mode over the recipe list, with a
   toggle, a way on and a portions stepper on every card. "Add to list"
   in the recipe view replaced it (J18.18); the recipe list is only the
   recipe list.
5. *Replaced by J18.18.* Portions default to the recipe's own servings and
   step the way the recipe view steps them (J4.2) — one serving at a
   time where servings are known, half a batch where they are not. **The
   recipe is never edited** (J4.3), and the number chosen is not kept.
6. *Replaced by J18.20.* A recipe can go on a list more than once.
7. *Replaced by J18.18.* The recipe view's own "Add to list" is the one
   control that goes with it. It is "+ List", and at 320px the row still
   fits inside the gutter with everything showing at once — an owner of
   two books (Copy and Move) with cook mode on ("Staying on") — measured
   in a browser, with the tracking and gaps tightened to make it so.
8. *Gone.* Items on a list do not follow the recipe they came from
   (J18.19).
9. **The lists have addresses** (`#lists`, `#list/<id>`; the old `#plan`
   leads to the Lists screen), so Back closes them the way it closes an
   open recipe (J4.17), and they are views rather than dialogs for the
   same reasons (J4.22) — a list is read one-handed in an aisle. A list's
   breadcrumb is the book, then Lists.
10. *Replaced by J18.4.* A read-only member reads lists and changes
    nothing, and gets no "Add to list".
11. *Replaced by J18.23.*
12. *Replaced by J18.22.*
13. *Replaced by J18.5–J18.7.* Anything can go on a list by typing it.

## J13 · Shopping from a plan

> Replaced by J18 (build step 1 has shipped). The summed shopping list —
> totals across recipes, plurals folded together, part-settled amounts,
> ✗ "already have", Copy and Share — is gone (J18.26). Two things it
> settled carry on in J18: editing in place (J13.16 → J18.6: the words are
> the editor, leaving saves, Escape puts back, an unchanged item writes
> nothing, a line break becomes a space, and the list does not redraw
> under an item being edited, J18.24), and an edit and a tick being two
> facts that merge apart (J18.23). The numbers J13.1–J13.16 are kept for
> the references that cite them.

## J14 · What the plan remembers

> Done, Clear and finished plans are gone with the plan readout (J18).
> What is recorded now is an add to a list (J18.21): each one writes one
> archived plan holding that meal, and "Last planned" and the sorts that
> read it stay as they were (J14.5 on). A book keeps its newest 2000
> records; at that, the oldest go to make room (migration 013) rather
> than an add being refused, and a device does not drop the newest
> record of any recipe to stay under its own cap (once the server has
> rolled a record off, though, the device follows it). Undo takes the record back
> even offline: it goes from the device at once and the delete is retried
> on the next sync.

1. *Gone* (J18.26). Done finished a plan and recorded it.
2. *Gone.*
3. *Gone.*
4. *Gone.* Clear discarded a plan without recording it — a plan that was
   cleared is still never reported as planned.
5. **What is recorded is that a recipe was planned, not that it was
   cooked.** This is a planner, not an oven: nothing here can know
   whether a pan was ever used. So the word is always "planned", and the
   date is the date it was recorded (J18.21).
6. A recipe's card and its recipe view say when it was last planned, the
   ordinary way of saying it — **"Last planned 3 weeks ago"** — because
   that is the question being asked, not which Tuesday it was.
7. **A recipe that has never been planned says nothing.** "Never planned"
   reads as a reproach on a recipe typed in five minutes ago. It still
   sorts where it matters (J14.9).
8. **The note sits on the line of particulars** — after "Serves 4 ·
   45 min" — in italic, rather than taking a row of its own. A card's
   rows are the scarcest thing it has. Where a recipe has no particulars
   to give, the note is the line. A card does not count its ingredients.
   ("In the plan" went with the live plan.)
9. **Least recently planned is one of the sorts** (J15.6): least recently
   planned first, never-planned before them. **It orders the list rather
   than narrowing it.** There is no honest threshold for "lately", and
   while you are deciding what to cook, hiding the recipes you have had
   recently takes away the comparison you are trying to make. In a menu
   called Sort the sort wins, and the ranking breaks its ties (J15.7).
10. How often a recipe has been planned is counted from the same archive,
    so "most often planned" needs nothing else stored. **Every appearance
    counts.**
11. **Nothing about planning is stored on the recipe.** A stamp there
    would bump its `updatedAt`, which reorders the list and would let a
    record overwrite an edit made on another device (J9.3). The archive is
    the record, and the recipe is left alone.
12. An archived plan keeps the names of the recipes it held, so a recipe
    deleted afterwards does not leave a blank line in what was planned.
13. *Gone.* Lines added by hand were not kept; a list's items now stay
    until somebody deletes them (J18.10, J18.13).

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

## J16 · Letting a program help

> Since J18 an agent has no plan to work on: lists replaced it, and what
> an agent may do to a book's lists is J18.25. Criteria below about the
> plan describe what the database still allows, not a tool anybody can
> call.

Someone wants an assistant — a program, running somewhere else — to read
their book and help with the week's plan. It is not a person and has no
Google account, so the app has to be able to let something in that is
not somebody.

1. **An agent is a member, not an account.** It holds a row in
   `book_members` with the role `agent`, so every read the book already
   allows a member, it allows an agent, by the policies that were
   already there. It has no email address, because it is not anybody.

   **An agent has no book of its own and cannot make one.** It is not
   given the book every new account gets (J1.3), and creating one is
   refused outright — so the one book it was placed in is the only book
   it will ever have, and everything it can reach is something an owner
   handed it. A credential that could make itself a library nobody can
   see would be an account, which is the thing this criterion says it is
   not.

   **An agent belongs to one book and cannot be added to a second.**
   Every member of a book can read its roster, and therefore an agent's
   id; without this, anybody in the household could attach it to a book
   of their own, where its owner could neither see it nor revoke it.
2. **Only an owner may add one**, from the Agents section of the Books
   dialog (**Add an agent with a key**, which opens a dialog of its own),
   and it is named when it is added. That name is what the member list shows — an agent
   nobody named is an agent nobody can recognise later. Adding one is a
   single call to the database, checked there against the caller owning
   the book and not being an agent; nothing signs in through the auth
   server, so there is no challenge to pass and no public way to make an
   agent at all.
3. **An agent may read the book, add recipes, and work on the lists.** It
   may not edit or delete a recipe — which is also what stops it
   favouriting one, a favourite being a property of the recipe (J3.6) —
   and it may not move one, invite anybody, change a role, or touch the
   book itself. Narrower than an editor (J7.3), wider than a viewer
   (J7.17).

   **The narrowness costs the client something, and the client pays it.**
   Recipes go up as an upsert, which is an insert that becomes an update
   the moment the row exists — so an agent pushing the way an editor does
   would be refused on the first recipe it had already sent, and one
   refusal fails the whole batch, taking every good insert with it. So a
   device syncing as an agent pushes what the server has never seen and
   leaves the rest alone. There are three answers to "may this device
   write", not two, and pretending otherwise is what makes an agent's
   sync park on a book that is perfectly well.
4. **An agent records what it plans, and does not undo or rewrite the
   record.** Since lists, a row in the record is a recipe going on a list
   (J18.21), not a week declared finished, and an agent putting a recipe
   on a list has planned it exactly as a person who does it has. Leaving
   that out would make "what we have not had in ages" (J14.9) a lie about
   the dinners the agent itself put on the list, and it would suggest
   them again. So it may add a record in its own book, the same one the
   app's "+ List" adds (014). It may not take one back — Undo is a
   person's — nor change one, nor write into another book's. Like
   anybody's, its record can roll the book's oldest record off once the
   book holds 2000 (013).

   **It also does not finish somebody else's.** A plan carrying
   `completedAt` is a Done that landed half way, and any device that may
   write is expected to complete it — archive it, and put an empty one in
   its place. An agent may do neither half, so it must attempt neither:
   clearing its own copy and then being refused the record would lose a
   week nothing could recover. It leaves the plan exactly as it found it
   and lets a person's device finish the job, which is what a viewer's
   device already does.
5. **An agent may clear the plan**, because Clear records nothing
   (J14.4) — the meals can go back and no history is written. It is the
   reversible half of finishing, and it comes with the same write that
   lets an agent settle a line at all.
6. **The key is shown once**, when the agent is added, and never again.
   It is `rfk_` and 256 random bits; the database keeps only its SHA-256
   and the first few characters, so the owner can tell keys apart in the
   list along with when each was made and last used. Losing it means
   removing that agent and adding another; the app says so where the key
   is shown, rather than leaving it to be found out. Nothing is lost by
   starting again — no recipe, plan or settled line records which member
   wrote it.
7. **An agent appears in the member list by name** (J7.18), marked as an
   agent, with the same × that removes a person. Removing it is
   immediate and entire: its key and its account go in the same statement
   as its membership row, whatever deleted the row — the ×, or the book
   itself being deleted. The hosted server may go on believing a key it
   has already resolved for at most a minute (J17.3), and no longer.
8. **An agent's role cannot be changed, to it or from it.** An agent is
   not a rung on the ladder that runs from viewer to editor: the roster
   offers no control that turns a person into a program or a program
   into a person. One that should be something else is removed and
   replaced, because a role change would silently widen a credential
   that was handed over for something narrower.
9. **A key is not given a lifetime.** An invite is short-lived because
   it is in transit and might go astray on the way (J7.4); a key is
   pasted into a configuration file and lives there, so nothing here
   counts down against it and the way it ends is being revoked (J16.7).

   **Nor does it quietly expire.** A key is not a session and carries no
   refresh token, so no rotation, reuse or session setting of the auth
   server can end it early. Earlier agents held a GoTrue refresh token
   and depended on exactly those rules; that is why they were replaced.
10. **An agent gets no stored photos.** It cannot read a photo out of
    private storage and cannot put one there, so it can neither see the
    pictures in the book nor add one. A picture *linked* by public URL is
    a different thing and does travel, because it lives on the recipe
    rather than in storage — the same line J6.2 already draws for a
    share link.
11. **What an agent writes is held to the floor every recipe is held to**
    (J2.1) and validated exactly as a pasted one is (J5.7). Being a
    program earns no latitude: a recipe with no name, no ingredient or no
    step is refused from an agent as it is from anybody.
12. **A key is checked by the database and read by nobody.** The hash
    lives in a table that no caller — anonymous, member, owner or agent —
    can read, and the one function that turns a key into an agent and its
    book answers only the hosted server's own role, never a signed-in
    caller and never the public. The old way of making an agent, an
    anonymous sign-in placed with `add_agent`, is refused for everybody.
13. **The owner can see every agent in the book**, in the Agents section
    of the Books dialog: its name, the start of its key (`rfk_` and a few
    characters, enough to tell two apart), the day it was added, and when
    it was last used — "never used" for one that has not been. Nobody
    else is shown the section, and a list that could not be loaded says
    so rather than looking like a book with no agents. Each has a ×, and
    removing one asks first and says what is true of no other removal:
    the key stops working straight away, and for good — connecting again
    means adding a new agent.
14. **Connecting a client is a copy and a paste.** Under the key, shown
    once (J16.6) in the dialog that made it, are ready-made settings for the clients somebody is
    likely to use — the Claude Code command, an `mcpServers` JSON entry
    (Cursor, a project's `.mcp.json`), OpenClaw's server entry, and for
    anything else the address, the header and a one-line `curl` that
    lists the tools — each with its own Copy. They are built from the
    page's own address and the new key, so what is pasted is exactly
    what this server answers, and the JSON ones are JSON. They exist
    only while the key does: closing that dialog — Done, Escape, or the
    Books dialog closing under it — takes the key and every setting made
    from it off the page, and opening it again starts afresh at the name.
    A refresh of the list while it is open does not.
15. **An app that signs in is an agent too.** Claude.ai, ChatGPT and
    Claude Code sign in rather than take a key (J17.15). When one asks,
    the auth server sends the owner to the site's own consent screen,
    which needs them signed in (the usual Google sign-in, with the
    request held across it) and then says which app is asking **and the
    host it will send them back to** — the name is whatever the app chose
    to call itself, and the host is the one part it cannot choose. It
    offers only books the person owns; an editor or reader with no book
    of their own is told that only a book's owner can connect an app,
    and can only Deny. Allow makes the app an agent in the chosen book
    — one call, checked against the caller owning the book and against
    the request being their own and still pending — and only then tells
    the auth server yes, so the token it issues has an agent to name.
    Deny tells it no and makes nothing. Connecting the same app again
    reuses its agent, or moves it to the book chosen this time.

    What to give the app is under **Connect an app**, beside the list: a
    dialog showing this server's address and the Claude Code command as
    text, each with its own Copy, and nothing secret — there is no key.

    It is in the Agents list with the rest (J16.13), marked as a
    connected app with its host instead of a key prefix, and removed by
    the same ×, whose question says it is signed out straight away and
    for good, and that using it again means connecting it again from the
    app.

---

## J17 · The program on the other end

> The plan tools (`get_plan`, `add_to_plan`, `remove_from_plan` and the
> plan's own list tools) went with the plan in J18. The list tools that
> replaced them — `get_lists`, `add_to_list`, `edit_list` — are J17.14;
> where another criterion here speaks of the plan, it describes what came
> before.

J16 let an owner place something that is not somebody in a book, and hand
it a key. This is what that key is handed *to*: a service in `mcp/`,
hosted beside the app at `/mcp`, which an assistant reaches with a URL and
the key, and which turns a household's book into a handful of questions
worth asking about it.

It is in this repository rather than one of its own because it is an API
onto this app. It runs the app's own modules and it is bounded by the
same policies, so a change to either can break it — and one repository
finds that out in the same test run, where two would find out after a
release.

1. **It is a service the household's server hosts, not a program every
   assistant runs.** MCP's Streamable HTTP transport at `/mcp`, stateless:
   each POST carries `Authorization: Bearer` and an agent key (`rfk_…`)
   or a connected app's access token (J17.15), and is answered on its
   own. No credential, or one that is not live, is a 401 with a
   `WWW-Authenticate` header rather than a tool answer, because no tool
   ran; GET and DELETE are 405, there being no stream to hold open and no
   session to end.

   **It can act as an agent and as nothing else.** It holds the JWT
   secret and uses it for two things only: a minute-long token for the
   one role that may resolve a key (J16.12), and a five-minute token for
   the agent the database named, with the role every signed-in caller
   has. From there every policy decides what the agent may do, exactly
   as it would for a person, so the security model does not fork.
2. **One key, one book.** The database says which book a key belongs to
   (J16.1) and nothing in the server chooses one, so a household with two
   books makes two agents. It is not a thing you point at a book; it is a
   thing you make for a book.
3. **It keeps nothing between requests.** No state file, no session, no
   cache of the book: every request builds its server, reads the book it
   needs and forgets it, so every question is a full pull — the path a
   new device takes on its first sign-in (J9.1).

   The one thing it remembers is which keys resolved, for at most a
   minute (thirty seconds by default), and only keys that worked. That is
   the bound on how long a removed agent's key can still be used (J16.7),
   and it is a bound the code enforces rather than a setting.
4. **The book opens on the first question, not on hello.** Every
   conversation starts by initializing and listing the tools, and a full
   pull for each is a cost somebody eventually removes by removing the
   server. A failure there also happens where nobody is looking, where a
   failure answering a question is something a person can be told.

   **A book that would not open is tried again, not remembered as dead.**
   A network that was down and an agent that was removed look alike from
   here and mean opposite things, and the difference must not come down
   to which happened first.
5. **A failure somebody could fix is a sentence.** It comes back as the
   tool's answer rather than as a protocol error, because a protocol
   error is for something the caller got wrong and these are things the
   world got wrong — and because an answer is something a model can read
   out to the person who can act on it. An agent removed between the
   key being checked and the book being read says to add a new agent and
   use its key; an unreachable project says to try again in a moment. Telling those two apart is the point of writing
   them separately.
6. **There is no tool for anything the key cannot do.** No
   editing or deleting a recipe, no favourite, no Done (J16.3, J16.4).
   No making, renaming or deleting a list (J18.25). Editing an item on a
   list is another thing, and an agent may (J17.14). A tool that exists
   and is always refused is worse than one that does not exist: the model
   keeps trying it, and reads each refusal as its own mistake rather than
   as a rule.
7. **The answers are this app's own arithmetic, not a second opinion of
   it.** The ranking is the search box's, "what we have not had in ages"
   is the sort menu's, and the combined shopping list is the list the
   phone shows. A reimplementation would drift on the things this app is
   careful about — promotion to kilograms, plurals, and not guessing how
   big a tin is — and nobody would notice until the list was wrong in a
   supermarket.
8. **A digest before a full read.** The listing tools answer with what a
   question about what to cook is actually asked against — name, tags,
   servings, total minutes, the ingredients a recipe is about, and when
   it was last planned — and a second tool reads in full the few that
   turn out to matter. A book handed over whole is a book nobody can
   think about.

   **What it says is what the household wrote.** Matching an ingredient
   uses a stem, so that "tomatoes" finds "tomato purée" (J3.4) — but the
   stem is a key and never a name. Printing it hands a model "ric",
   "chees" and "win" to read back to somebody, and the app never shows
   one: every line on screen says the word that was typed, which is what
   makes an over-eager match visible (J13.7).

   **And what it says is what the screen would say.** A recipe that
   leaves the book leaves the plan (J12.8), which the app makes true on
   every render; a tool answering from the plan as stored lists a meal
   the phone does not show and buys nothing for it. It is reported away,
   not taken away — a question does not make a write, and the next
   device to draw the plan will do that. The same rule is why a meal
   planned by a multiplier says so: the screen shows "× 2", and without
   it one batch and three are the same answer.
9. **The book is read before every question and before every change.**
   Not only before a write: an answer about the plan computed from a
   snapshot taken an hour ago is the same wrong shopping list as one
   computed by the wrong code, and the household goes on cooking while a
   session is open.

   Before a *change* it is what makes the change safe at all. Meals do
   not merge the way settled amounts do (J12.11): for one plan the more
   recently touched body wins whole. A tool that wrote back a plan it
   read some minutes ago would not lose a race occasionally — it would
   delete whatever somebody added from a phone in between, every time.
   And because a write can still be dropped by one that lands a moment
   later, **what a tool reports is what survived, not what it asked
   for**, and a meal that did not survive is named as dropped.

   **Two questions asked at once are one read; a change has the book to
   itself.** A model turn commonly carries two tool calls. The sync
   underneath answers a second, overlapping call by doing nothing, which
   must not reach anybody as a network that is down — so questions share
   one read.

   A change takes the book whole, from its read to its push, and
   everything else waits. It is read-modify-write against a plan that is
   one row for the shared book, and its undo is that plan as it was:
   neither is true if anything else touches the book in between. Two
   changes overlapping take each other's work as their starting point. A
   *question* overlapping is worse, because it does not look like a
   writer at all — the sync it runs applies the plan it read over the top
   of the change and pushes what it read, and the change is then judged
   against a plan it never got into: reported as landed when it never
   went, or blamed on another device when there was no other device.

   **A change is stamped past the one it replaces.** Two copies of one
   plan are told apart by when each was last touched, and a tie is
   broken on a fingerprint that the copy holding *more* meals loses as
   often as not — so two changes landing in the same millisecond were a
   coin flip on whether the second one existed, reported as somebody
   else's write from a device nobody was using. The app has the same
   hazard where a settlement and the tap retracting it can share a
   millisecond, and the same answer: stamp one past the value being
   replaced, so the same hand cannot tie with itself. Taps are far apart
   and rarely meet it; a program is a much faster hand.

   **Both controls, or the promise is not kept.** A recipe that says what
   it serves is planned by portions and one that does not by a
   multiplier (J12.4), and the screen has a control for each. A server
   with only the first cannot put a batch cook back the size it came
   out at — the meal returns as one batch and the shopping list halves,
   under a tool that says taking a meal out is reversible. So both are
   offered, asking with the wrong one is a sentence rather than a
   silently unscaled meal, and what comes out of the plan says how much
   of it there was.

   **A week that has been finished is not one to add to.** A live plan
   carrying a completion is a Done that landed half way, waiting for a
   person's device to file it away (J16.4). Writing into it would put
   the agent's meal into the record when that device finishes the job,
   which is the one door J16.4 does not otherwise stand in front of.
10. **Filing a recipe is one way, and the tool says so twice.** Once to
    the client, in the hint it reads when deciding whether to ask a
    person first, and once in words, which is what the model reads when
    deciding whether to try. An agent cannot delete even the recipe it
    just added (J16.3), so this is the one call here that nobody on this
    side can take back.

    **So a recipe is never reported wrongly in either direction.** A push
    and the rest of a sync share one failure between them, and the
    recipes go up first — so "it failed" can mean the book has it. Said
    wrongly one way, the retry it invites files a second copy that only
    a person can remove; said wrongly the other, the cache dies with the
    process and takes a recipe somebody was told they had. So the book
    is asked. It is filed, or it is not filed and saying so invites the
    retry, or nobody could find out — and that last one is said in those
    words rather than dressed as either of the others.

    **The row comes out of the cache before the book is asked**, because
    asking is the one moment a write waits on the network without
    holding the sync it started, and a row left sitting there is one
    another call could push while it is being decided. **And it goes
    back if nobody could find out** — throwing it away on an unanswered
    question loses a recipe that may never have been filed, and putting
    it back is safe because it keeps its own id, which a later sync
    pushes only if the server has never seen it.
11. **What the book says is content, never instruction.** Everything a
    tool hands over was typed by somebody in the household or arrived
    with a recipe brought in from a web page (J5), and it reaches a model
    in exactly the shape a request would. Every tool that hands any of it
    back says so where the model will read it — the questions, and the
    two that change the plan and answer with meal names and a shopping
    list. `sanitizeRecipe` is the backstop on the way back in (J16.11),
    and the tool that files a recipe carries the other half of the
    sentence: bring back the recipe and nothing else the page asked for.

    **And what arrives as a tool's arguments is checked by this server or
    by nothing.** The protocol lets a tool publish the shape of what it
    takes and does not hold anybody to it, so a field the schema never
    declared arrives exactly as easily as one it did. A write therefore
    takes the fields it means to take, one at a time, rather than passing
    on what it was handed: the app has always built a recipe that way,
    and the sentence in a description asking for a recipe and nothing
    else the page wanted is a courtesy, not the gate.

    **The bar for the rest is that a tool answers or says why it cannot,
    and never answers wrongly.** A type nobody expected is worth a
    sentence; an order nobody offers is worth a refusal rather than the
    book's own order returned as though it were the answer; a list longer
    than the schema allowed is worth refusing rather than working
    through, because a change holds the book while it runs.
12. **A recipe can be read at the size it is going to be cooked.** "What
    do I need for eight" is one of the few questions worth asking a
    recipe, and the arithmetic is the part a model is worst at and least
    checkable on: an amount it worked out itself arrives with nothing
    marking it as its own. So the tool that reads a recipe takes the
    size, and the app scales it — the same multiplication the Portions
    stepper does (J4.2), rendered in the same kitchen fractions (J4.7),
    so half of "1½ tbsp" is "¾ tbsp" here too.

    **The same two controls as everywhere else.** A recipe that says what
    it serves is asked for in servings and one that does not by a
    multiplier (J12.4). Asked in portions, a recipe with no servings has
    nothing to divide by, so it comes back as written and named as
    unscaled with the control that would work — never scaled by a guess,
    which is a wrong answer with nothing marking it either. A multiplier
    is refused on neither: half of this is meaningful for any recipe, and
    unlike a meal in the plan nothing here is stored, so no control has
    to match what a stepper will later step.

    **What is scaled is said, and so is what is not.** Times and the
    method are the recipe's at any size, and an amount written into a
    step — "add 200 g of flour" — is the step's own text and is not
    touched. That is a sentence in the answer rather than only in the
    tool's description, because it is the one way a model can tell the
    scaled numbers from the unscaled ones sitting beside them.

    **The recipe's own `servings` stays what the household wrote**, with
    the size asked for reported separately: one field meaning the stored
    recipe to one caller and the question's answer to another is a recipe
    answering about two different dinners.

    **And no size is answered at that stops meaning anything.** A
    hundred thousand portions is past every dinner and short of every
    overflow, and past it the multiplication runs out of numbers: an
    amount that overflows leaves this server as JSON `null`, which is
    the shape of an ingredient that never had an amount — an answer
    wrong in the one way nothing here may be wrong (J17.11). At the
    other end, an amount is never reported as `0` and a size never as
    "Serves 0": both are a statement that nothing is there about a
    dinner somebody is going to eat.

    **The text is the screen's and the number is the truth.** J4.8's
    floor renders anything below 0.05 as "0", so a recipe taken far
    enough down says "0 tsp" for something that is present — accepted on
    screen because the recipe as written is one tap away, and a model has
    no tap, so the number sits beside the text. It is rounded to the
    thousandth: 200 ÷ 3 is 66.66666666666667, and that is float noise
    dressed as a precision no recipe was ever written to.

    **And it is a question.** Scaling on screen is display-only and the
    saved recipe never changes (J4.3); asking for a size here writes
    nothing, the same way.
13. **A tool description says what the tool does, what it takes and what
    comes back — never why it was built that way.** The tool list is read
    at the start of every session and charged for whether or not a single
    tool is called, so it is the one piece of writing here with a running
    cost. Reasoning is free to read in the code and in these journeys,
    and a caller can act on none of it: "because unit preferences belong
    to a person and an agent is not one" told a model nothing it could
    do differently, and neither did the shopping list's plurals or the
    portion stepper being the thing that multiplies.

    **What comes back is worth the words.** Every tool names the fields
    in its answer, because the alternative is a call spent finding out —
    which costs more than the sentence saves. The same reasoning trims
    the other way: a rule the server enforces with a clear sentence of
    its own does not also need saying in the schema, since the schema is
    paid for every session and the sentence only when it is needed.

    **The guard on this is a budget, not a style.** A test measures the
    whole listing and fails when it grows past what nine tools can
    justify, and names the phrases that were shipping before this was
    written down — the point being that descriptions grow back.
14. **The book's lists, through three tools** (J18.25): one reads them,
    one adds to one, one changes what is on one. A list is named the way a
    person would name it — "shopping", in any case — or by its id, and a
    name that is not a list's is answered with the names that are and a
    sentence saying an agent does not make lists. There is no tool to
    make, rename or delete one (J17.6), and the database refuses all
    three in any case (J18.25).

    **Deciding that two lines are one need is the agent's job when the
    agent is adding.** The app never combines one item with another
    (J18.19), and the server is not a second opinion on that: it adds
    what it is given. So the tool says to read the list first, and where
    the thing is already on it to decide whether this is more of it, the
    same need, or something else — and to edit that item, add another,
    or leave it. Somebody saying "we need milk" twice in a chat should
    not become two lines of milk.

    **An item is changed where it stands, not taken off and put back.**
    "Make that 7 eggs", "actually oat milk" and "one fewer bolognese" are
    edits to an item already there: the edit keeps its id, its place and
    its tick, where deleting it and adding it again loses the tick, moves
    it, and makes the list jump on somebody's phone.

    **An edit to the words says what it read.** It carries the text the
    agent read, and where a person has changed the item since — on their
    phone, a minute ago — it is not written over: the answer is the item
    as it now reads, to be read again and decided on. An edit that does
    not say what it read is refused, since it cannot tell itself from an
    overwrite. Emptying an item is not an edit from here; deleting is
    asked for in so many words, so a blank from a confused model deletes
    nothing.

    **A count is set as taps.** "There are three left" is the agent's own
    + and − from what the counter shows when it is asked, on a device id
    of its own that is the same on every request (J18.17) — never a
    number written over the household's taps. So a phone that took one
    out in the meantime still counts, and what comes back is what the
    counter now says.

    **A recipe goes on as a person's does** (J18.18): one item at the top
    of a checklist, its ingredients under it, at the servings asked — or
    a multiplier, for a recipe that does not say what it serves (J17.12).
    It is recorded as planned the way the app records it (J18.21,
    J16.4), by the same sync as the list; the answer says whether the
    record landed, because a list can go up while the record is left
    behind.

    **It is held to what a person is held to.** An item is a line, capped
    as a person's is; a list is full at the same size; fifty changes at
    most to a call. Every change is the app's own operation, merged and
    written back by the same sync a phone runs — over the row it merged
    with, and read again and merged again if somebody wrote in between —
    so a phone and the agent converge (J18.23). What is reported is what
    the book holds afterwards, read back from it (J17.9): a change that
    did not get in is said not to have, and is not left behind to go up
    with the next question's sync.

    **Whether it got in is judged by its own changes.** Not by whether
    the sync raised — the plan half can fail after the list went up —
    and not by the whole list matching, which a phone ticking milk a
    moment later would spoil. Saying "nothing was saved" about something
    that was is how a retry puts it on the list twice. And what a call
    did to itself is not another device's doing: unticking one
    ingredient unticks the recipe it is under (J18.11), and deleting an
    item takes what is under it (J18.10), so what is blamed on somebody
    else is only what differs from the list as the whole call left it.

    **A write answers with what it touched**, each item as it now stands,
    a line saying what happened and the list's size — not the list, which
    on a long one is thousands of words for one tick (J17.8, J17.13). A
    change that changed nothing says so ("Already so."), and a counter
    can always be set to any count from 0 to 9999: an agent whose own
    tally is full counts on a spare slot of its own (J18.17).
15. **An assistant can sign in instead of being given a key.** The
    clients people actually use — Claude.ai and ChatGPT connectors,
    Claude Code — speak MCP's OAuth, and Claude.ai has nowhere to paste
    a key. So a request with no credential is told where to sign in: the
    401 names this server's protected-resource metadata (RFC 9728), at
    `/.well-known/oauth-protected-resource/mcp`, which names the auth
    server (GoTrue, issuer `…/auth/v1`) — whose own metadata is found at
    every place a client derives from that issuer, path-suffixed and
    not. Apps register themselves (dynamic client registration), use
    PKCE, and are sent to the consent screen (J16.15). The scope is
    fixed at the one the auth server can always issue: asking for
    `openid` would have it make an ID token it cannot sign, so it is not
    asked for, whatever the client wanted. What an app may do is the
    agent role's business, not the scope's. Keys are unchanged, and are
    still what an unattended agent should use: a key does not expire,
    where a signed-in app holds a refresh token that rotates.
16. **A connected app's token is its agent's, never the person's.** The
    auth server would issue the person's own session, good at the REST
    API, storage and the auth server itself. Instead, a hook in the
    database rewrites every token it issues to an OAuth client: the
    subject becomes the agent the app was connected to, the role one
    that nothing will switch to (so the REST API and storage refuse it
    outright), the audience this server, and none of the person's
    details remain. An app with no agent gets no token at all. This
    server checks the token in full — signature, expiry, issuer,
    audience, role, client — before asking the database anything, then
    asks, as the one role that may (J16.12), whether that agent is still
    bound to that app and in its book, and from there acts exactly as it
    does for a key: a five-minute token for the agent (J17.1). A
    person's own session is refused here, and so is the agent token
    this server mints.
17. **Removing a connected app ends it.** Whatever deletes its
    membership row also deletes the person's consent for that app and
    every session the auth server issued it, so its refresh token is
    dead in the same statement. Its last access token names an agent
    that no longer exists; this server stops believing it within the
    same bound as a key (J17.3).

---

## J18 · Lists

Somebody keeps the household's lists in the app: the shopping, what is in
the freezer, whatever else is worth writing down. The shopping list as
J12–J14 built it — totals summed across recipes, part-settled amounts, a
plan mode over the recipe list, Done — was too much to read in an aisle
and was not used. Its replacement is a plain list that is good to use,
and a recipe drops onto it as a single item.

### Lists

1. **A book holds any number of lists**, each with a name — "Shopping",
   "Freezer", "Cupboard". They belong to the book the way its recipes do
   (J3.6): every member sees every list, and switching books switches
   lists.
2. **A list is one of two kinds, chosen when it is made, and the kind
   does not change afterwards.**
   - A **checklist** has a tick box beside each item. Shopping is a
     checklist.
   - A **stock list** has a counter beside each item. The freezer is a
     stock list.

   Everything else in this journey is the same for both.
3. A list can be renamed. Deleting one asks first, because it takes every
   item in it.
4. **A read-only member reads lists and changes nothing**, the same rule
   as recipes (J7.17).

### Items

5. **An item is a line of text**, and the text is what you read: nothing
   else shares its row but the tick box or the counter.
6. **Tap the text to change it.** The words are the editor, with the
   rules J13.16 already settled: leaving the item saves it, Escape puts
   back what was there, an item left unchanged writes nothing, and a line
   break becomes a space.
7. **Enter makes the next item**, directly below and at the same depth,
   with the cursor in it — so a list can be typed out without touching
   anything else. On an item that has others nested under it, the new
   item is its first child, so it is still directly below rather than
   after however many ingredients a recipe has.
8. **Items nest.** Swipe an item right to put it under the one above;
   swipe left to bring it back out. On a keyboard, Tab and Shift-Tab do
   the same. Whatever is nested under an item moves with it.
9. **Drag to reorder**, by holding an item. Dropping it to the left or
   right of where it started changes its depth the way a swipe does.
10. **Emptying an item's text deletes it**, and says so with an Undo.
    Backspace in an item that is already empty does the same and moves
    the cursor to the end of the item above.

### Checklists

11. **Ticking an item ticks everything nested under it**, and unticking
    it unticks them. Ticking a recipe (J18.18) is how a recipe that is
    no longer wanted goes from the list in one tap.
12. **Ticked items fold away.** They go to a "Ticked (n)" group at the
    bottom of whatever they are nested in — at the top level, the bottom
    of the list — collapsed until it is opened. Unticking one puts it
    back where it was.
13. **The ticked can be cleared.** "Clear ticked" deletes every ticked
    item in the list, with an Undo.

### Stock lists

14. **Each item has a counter, `− 3 +`.** A new item starts at 1. One
    tap on − or + changes it; no typing is needed to say one has been
    used.
15. **At 0 an item stays on the list, faded**, so the list shows what
    has run out. It is never taken off by the counter, only by deleting
    it (J18.10). The counter does not go below 0.
16. **An item with something nested under it is a heading and has no
    counter** — "Top drawer" holds things rather than being one. If what
    is under it goes, its counter comes back.
17. **Two people taking one each both count.** Two phones that each tap
    − on "Bolognese 4", even with no signal, leave it at 2 when they
    meet, not 3. The counter merges as changes, not as whoever wrote
    last.

### Putting a recipe on a list

18. **A recipe goes onto a checklist as one item, with its ingredients
    nested under it.** From the recipe view, "Add to list" asks which
    checklist and at how many portions — starting from the recipe's own
    servings, stepped the way J4.2 steps them — and adds the recipe's
    name as an item at the top of that list, with each ingredient under
    it at that size, in the reader's own units (J8).
19. **After that they are ordinary items.** They can be edited, ticked,
    reordered or deleted like anything typed. Editing the recipe later
    does not change the list, and nothing is summed with another recipe:
    two recipes that each want onions show onions under each.
20. A recipe can go on a list more than once; each add is its own item.
21. **Adding a recipe to a list is what "Last planned" records** (J14.5,
    J14.6). The date is the day it was added. Undoing the add takes the
    record back. Planning history already recorded is kept.

### Sync

22. **Lists work with no network** (J9.1), and changes made offline are
    kept when the phone reconnects.
23. **Two phones working on one list both keep what they did.** Each
    item's text, its tick or count, and its place in the list merge
    separately, so an edit on one phone and a tick on the other both
    survive (J13.16).
24. **Changes from other members appear within seconds**, without
    reloading. The list does not redraw under an item being edited
    (J13.16).

### The agent

25. **An agent (J16) sees every list in its book** and can read them,
    add, edit, move, tick and delete items, change counts, and put a
    recipe on a checklist at a chosen size (J18.18). It cannot make,
    rename or delete a list — those belong to the people in the book, the
    way deleting a recipe does (J16). A recipe it puts on a list is
    recorded as planned, as a person's is (J18.21, J16.4).

### What goes

26. Removed by lists: summing across recipes and everything that
    serves it (J13.1–J13.12), part-settled amounts and ✗ "already have"
    (J13.9–J13.14), plan mode and the portions stepper on recipe cards
    (J12.4–J12.7), Done, Clear and the archive of finished plans
    (J14.1–J14.4). "Last planned" and the sort by it stay (J14.5 on,
    J18.21).

### Getting to a list

27. **The recipe page has the book's lists as the app bar's second
    row**, one link to a list, in the order of the Lists screen and
    showing only its name, in the bar's own small capitals — no boxes.
    Tap one and that list opens. Each is a 44px target. The lists run
    from the left; any that do not fit are hidden, never wrapped or
    scrolled, and the row always ends, at the right, with "All lists ›",
    which is never hidden. A book with no lists shows a single "Lists". A
    read-only member sees it too (J18.4). The row is part of the bar, so
    it is there wherever the bar is: on the recipe list, not in a view.
28. **A list's header is one line**: the way back, the list's name, and
    when it was last changed, right-aligned in small muted words —
    "Edited just now", "5 minutes ago", "2 hours ago", and from a day on
    the day wording of "Last planned" (J14.6). On a phone the way back
    is a ‹ (the same step as the trail's Lists); wider, it is the trail,
    "<book> › Lists ›", leading into the name. A long name ends in an
    ellipsis and the edited time never wraps. The line stays at the top
    as the list scrolls. The name is still renamed in place (J18.3); a
    read-only member gets the same line without that. The edited time is
    worked out from the list's own dates, a counter tap's included (each
    item's counter keeps the date of its latest change, merged by the
    newest), so it is there offline and moves when a change arrives. It
    stays current while the list is open, and says nothing if the list
    holds no date. An agent reading the lists (J18.25) gets the same
    time for each as `editedAt`, never later than now (a device with a
    wrong clock cannot pin a list in the future). It counts every change,
    the agent's own included, so it says how fresh a list is, not who
    keeps it up.
29. **On a phone the app bar is one line**: logo, title, "+ New" and
    "···". The title is the book you are in, with a ▾, and opens Books;
    there is no separate Books button and no account name in the bar —
    "···" opens with "Signed in as <name>". The sync status gets a line
    of its own only when it needs attention, that is when sync is failing
    (J9.6); saving and syncing do not, so a normal sync never changes the
    bar's height. Signed out, or before
    the book is known, the title is "Recipe Friend". Wider screens keep
    the full bar: the wordmark, the account, the book and the status,
    "+ New recipe", Books and "···".

### How it arrived

In three steps, each a pull request, all shipped. First lists and items,
with each book's plan moved into a checklist called "Shopping" — its
typed lines became items with their ticks, and each planned recipe a
recipe item at its planned portions (J18.18) — and the agent's plan
tools switched off. Then "Add to list" on a recipe, in place of plan
mode. Then the agent's list tools (J18.25, J17.14).

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
- A list is not a calendar: nothing on it belongs to a day or a date
  (J18.5). An assistant that thinks in dates keeps them on its own side.
- **One key, one book, and no book of its own** (J16.1). An agent
  cannot be added to a second book, cannot create one, and is not given
  the one a new account gets. All three are enforced rather than
  intended, and the reason is the same each time: everything an agent can
  reach should be something an owner handed it and can take back.
- **An agent does not star.** A favourite is a property of the recipe and
  shared by the book (J3.6), so starring is an edit, and J16.3 does not
  give an agent edits. A program's taste is not the household's.
- **An agent has one narrowing that is not a permission**: it sees no
  photos (J16.10). Everything else about what it may do is a policy, and
  the client is written to stay inside them rather than to discover them
  by being refused.
- **Read-only is not confidential, and neither is an agent's read**
  (J7.17). Anything an agent can read it can copy out. Removing it stops
  it reading more; it does not retrieve what it already has.
- **The hosted server holds the JWT secret, and that is the cost of
  agents.** Anything holding it can sign a token for anybody. The server
  is kept narrow instead of trusted wide: it signs only for an id the
  database returned for a live key, only as `authenticated`, and only for
  minutes (J17.1), and its only way in is the reverse proxy. The
  alternative — checking the key inside Postgres on every request, with
  no secret outside the database — needs PostgREST's pre-request hook to
  change role mid-request for every caller of the API, which is a wider
  change to the thing every request passes through than one service
  holding a secret it already has a narrow use for.

  **What it bought.** Agents are no longer anonymous accounts, so the
  project no longer needs anonymous sign-ins at all, and with them gone
  there is no public endpoint that creates an account — and no challenge
  needed in front of one. An agent no longer depends on any rule of the
  auth server's refresh tokens (J16.9). Earlier agents did, and
  `mcp/session.js` existed to survive those rules; it is gone.
- **The logic modules carry no DOM, and that is load-bearing outside
  this app.** `plan.js`, `lists.js`, `listdrop.js`, `search.js`,
  `scale.js`, `units.js` and `html.js` name nothing a browser provides;
  `storage.js`, `planstore.js`, `liststore.js` and `sync.js` reach no
  further than `localStorage`. It is what lets the server in `mcp/` — the
  thing an agent talks to (J16) — answer by running the household's own
  code rather than a second implementation, which would drift on exactly
  the things this app is careful about: scaling, units and plurals.
  Breaking it costs nothing visible in the app, so it is held by a test
  rather than by anybody remembering.
- A read-only member reads every list and changes nothing on any of them
  (J18.4), the same rule as recipes.
- **A list is what was put on it.** There is no pantry of staples that
  refills itself, no ordering by aisle — which would need the app to know
  what a supermarket is — and nothing is summed: two recipes that each
  want onions show onions under each (J18.19). A recipe on a list does
  not follow later edits to the recipe.
- **Emptying an item deletes it** (J18.10), with an Undo, rather than
  putting back what it said. Escape is the way to abandon an edit.
- **Deleted is final.** A deleted item is a tombstone that no older copy
  can bring back (J9.4); Undo puts back copies of what went, under new
  ids. Holding on to an old id across an Undo finds nothing.
- **A list's kind is for good** (J18.2). A checklist does not become a
  stock list; make another list.
- **A counter merges as changes, not as whoever wrote last** (J18.17),
  and never shows below 0 (J18.15). Two phones each taking the last one
  leave it at 0, and + from there means one, not two.
- **"Within seconds" is a poll** (J18.24): while a list is on screen and
  the tab is visible, every few seconds and on coming back to the tab.
  There is no realtime service in the stack, and a list nobody is
  looking at is not polled.
- **An export carries recipes, not plans or lists** (J10.1). Planning
  history lives in the book's archived plans and does not survive a
  restore into a new account, in the same way a photo does not (J10.4).
- There is no shareable list link; J6.6 still holds.
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

It also covers the MCP server (J17), which is the same kind of risk
wearing different clothes: a wrong answer computed somewhere with no
screen to notice it on. The `mcp-*` files stub the eight calls sync
makes rather than the whole of PostgREST, so what they hold is which of
those an agent is allowed to reach for — and `mcp-http.test.js` drives the
real HTTP handler for what a caller without a good key is told.

**Fourteen criteria have no test naming them** — J4.15, J4.16, J4.19,
J4.25, J5.10, J6.3, J10.4, J11.1 to J11.5, J15.9 and J15.11. (J12.12, that
the plan worked offline, was the fifteenth; lists replaced it with J18.22,
which has tests of its own.)

Five of those are a correction rather than a change. J4.19, J6.3, J10.4,
J11.5 and J15.9 had been counted as covered for a long time and are not:
each is named in a comment or an assertion message somewhere, never in a
test title, and the total had been kept by arithmetic — adding new
criteria and new tests to the old figures — rather than by counting.
Counting is the only reason the number moved. **The convention is that a
test title quotes its criterion**, and that is what is measured here.

J16.5 was the last one left of that journey, and came off when the
database got tests of its own (below): it is a policy — an agent may
clear a plan — and nothing else could have held it.

Two of its neighbours were on this list until the MCP server arrived and
came off it, which is the clearest thing that server earned. J16.9 —
that a key does not expire — is held by the hosted server's tests, which
use one key across requests and see it stop only when revoked. J16.10 — no stored photos — is a policy at the database
and a decision in `mcp/digest.js` about what a tool hands back, and the
second half is tested. Neither was ever something a stub DOM could be
asked about; both are something the program on the other end of the
credential can be.

Four more things the tests do not reach, recorded so the
gap is visible:

- **The resampling and JPEG encoding behind a device photo** are the
  browser's canvas, not ours (J2.7). The tests check the size and quality
  the app asks for; that the result is a smaller, readable JPEG is taken on
  trust.
- **Deployment and hosting** (J11) are a static host, a tunnel and a
  pinned commit in another repository. There is no code to exercise, and J5.10 records a reason
  for a decision rather than a behaviour.
- **What the recipe view looks like at a given size** (J4.15, J4.16,
  J4.25), and **that an open menu covers the list rather than shoving it
  down the page** (J15.11), are media queries and absolute positioning,
  and the stub DOM has no layout: it has no viewport, so it cannot be
  asked what fits on one. That the breadcrumb collapses to one link on a
  phone (J4.23) is a media query for the same reason; what it says, and
  where each crumb goes, are behaviour and are held by tests. J4.17,
  J4.18, J4.20, J4.21, J4.22, J4.24 and J2.11 are behaviour and markup
  and are held by tests; the rest was measured in a
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
  control in the recipe view (J12.7) was shown only in plan mode (it is
  now "+ List", J18.18, which is always there for someone who can write)
  and the bar held one row at 320px. Adding it took the bar's tracking
  and gaps down a notch at narrow widths; see J12.7. Both entries that moved were already
  the tightest of the seven, and both lose their last line rather than
  their first — which is the shape of the deferred preamble again, not a
  new problem. The line is not paid for anywhere: shrinking the preamble
  stays deferred, and this records what deferring it now costs.

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
  panels paint over the active row rather than reflowing it. **Neither
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

**The database is inside the net now.** The row-level security policies,
the definer functions and the triggers are the security model, and for
as long as the app had them they were verified by hand in the Supabase
dashboard, because CI had no Postgres to run them on. `server/` is that
Postgres: the same images production runs (Postgres, GoTrue, PostgREST
and Storage behind Caddy), brought up by CI's `db` job, migrated by
`server/migrate.sh`, and asked directly by the `test/db-*` files. Those
skip when `DATABASE_URL` is not set, so `node --test test/*.test.js`
still needs no Docker.

Most of them act as a user the way PostgREST does — `authenticated`, with
that user's claims — inside a transaction that is rolled back, and each
checks the case that is allowed **and** the case that is refused, since a
policy that refuses everything passes half of every test. A refused
update or delete is not an error, only a row that did not change, so
those count rows and read the row back. What they hold:

- the new-user trigger: a profile and one book named after the person
  (J1.3), and a profile and **no** book for an agent (J16.1);
- signed out, nothing at all (J1.1);
- who may write to a book — editors yes, viewers and strangers no, a
  favourite being a write (J7.3, J7.17) — and that a viewer can still copy
  a recipe out (J7.16);
- membership as consent: nobody can be put into a book, only join one they
  own or redeem an invite (J7.5), leaving and removal (J7.6, J7.12), and
  deleting a book (J7.8);
- invites: one person, 48 hours, revocable by the owner and only the owner,
  a preview that joins nobody, the role a link grants, never ownership, and
  closed to anonymous callers (J7.4, J7.5, J7.17);
- `move_recipe`: the owner's, into a book they can write to, as a copy and a
  tombstone (J7.10);
- the three immutability triggers — a recipe's book, a membership row's
  person and book, a plan's book (J7.10, J7.17, J12.2) — and the owner
  changing a role along the ladder but never to owner (J7.17);
- the plan: a viewer cannot plan (J12.10), one live plan per book that only
  its editors write, a week recorded once per book (J14.10), and Undo
  (J14.2);
- agents: no book of their own, one book only, never a person placed as one
  (J16.1), placed only by the owner (J16.2), reading, adding and planning
  and nothing else (J16.3), recording a plan and never undoing one (J16.4),
  clearing one (J16.5), gone when removed (J16.7), and a role that cannot
  be changed to or from (J16.8) — all of it still true of an agent whose
  account has been turned into a permanent one (below); and keys:
  stored only as a hash, readable by nobody, resolvable only by the
  hosted server's role (J16.12), revoked with the agent (J16.7);
- the Storage rules: members read a book's photos and strangers do not
  (J2.8), viewers cannot add or remove one (J7.17), and an agent gets none
  (J16.10).

Four more, in `db-e2e.test.js`, run the app's own `RecipeApi` through the
supabase-js it ships, over HTTP, against the whole stack: a recipe and its
tombstone round-tripping (J9.4), an invite previewed, redeemed and refused
the second time (J7.4), a photo uploaded and read back through a signed
URL (J2.8), and an agent made the way the Agents section makes one, adding a
recipe and refused an edit (J16.3). `db-mcp-http.test.js` does the same for
the hosted MCP server: no key, a wrong key, a good key listing the nine
tools and reading the book, a revoked key refused within the cache
bound (J17.1, J17.3, J16.7), and a phone and the agent working on one
list and both keeping what they did, with the agent refused a list of its
own (J18.23, J18.25). They are there for the gap between
what the SQL allows and what the client sends, not as a second copy of the
policy tests.

The tests were themselves checked by breaking what they hold: dropping
two of the immutability triggers, taking the agent clause out of the
third, loosening the photo rule, the live-plan insert policy, the
plans insert policy and the guard on creating a book, and taking the
checks out of `redeem_invite`; and for migration 009, answering "no"
from `is_agent_user` and putting `add_agent` and `discard_orphan_agent`
back to 008's rules. Each turned the tests that name it red.
That was done once, by hand, and is not repeated in CI.

What the database tests do not reach:

- **The two quotas** — 2000 recipes and 2000 recorded plans a book — are
  triggers no test fills.
- **The sign-in settings** are GoTrue's configuration, not the schema, and
  are not tested: that email sign-in is off, that Google is the only way
  in, and that anonymous sign-ins are off.

  The agent rules used to lean on one more: that an anonymous account
  cannot be turned into a permanent one. GoTrue allows it wherever email
  sign-in or manual identity linking is on, and on the development stack,
  which has email on, an agent's own credential was enough. 008 asked
  "is this account anonymous" to decide who was an agent, so a converted
  agent could make itself a book, redeem an invite link, and outlive its
  own removal. The tests found it; migration 009 closed it by asking
  instead whether the account was ever placed as an agent, which
  `add_agent` records and conversion cannot change. The tests for it act
  on a converted account directly. Production keeps those settings off
  regardless.
