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

## J3 · Finding something to cook

1. Search matches across names, descriptions, ingredients and tags.
2. Tag chips and the Favourites filter narrow the list, and combine with
   search.
3. "What can I cook?" takes a list of ingredients and ranks recipes by how
   many they use, best first, each card naming which of the ingredients it
   uses.
4. Ingredient matching tolerates simple plurals, so "tomatoes" finds
   "tomato purée".
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

## J5 · Bringing in a recipe from outside

Covers a share link someone sent, and a recipe an assistant wrote out.

1. Opening a share link shows the recipe in the edit form, titled **Review
   recipe**, so it can be renamed or corrected before it is saved. Nothing
   is stored until it is confirmed.
2. A recipe keeps its identity through that review, so opening the same link
   twice updates the existing recipe instead of adding a second.
3. When the recipe is already in the box, the form shows the sender's
   version and the button says **Update my copy**, because saving replaces
   what is there.
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
4. There is no multi-recipe share link, by choice.

## J7 · Cooking together: books and membership

1. Everyone's first book is named after them and can be shared as it is.
   There is no separate "personal" tier to migrate out of.
2. Anyone can create more books, and switch between them from the header.
3. Everyone in a book can add, edit and delete its recipes.
4. An owner can invite others with a link that works for 7 days. **The link
   is reusable within those 7 days** — anyone it is forwarded to can join.
   Treat it as you would a house key.
5. A member can leave a book; its recipes stay with the book.
6. An owner cannot leave a book. Their exits are to keep it or to delete it.
7. An owner can delete a book, which destroys its recipes for every member.
   The confirmation states how many recipes and how many other people are
   affected first.
8. Nobody can delete their last remaining book — there would be nowhere for
   new recipes to go.
9. A recipe can be moved to another book you belong to. It keeps its
   identity, and its photo moves with it so that the new book's members can
   see it.
10. When a book you are in is deleted by its owner, the app moves you to
    another of your books, says what happened, and forgets the deleted
    book's local copy.

## J8 · Measurements that suit the cook

1. Weights can be shown as grams/kilograms or ounces/pounds; liquid volumes
   as millilitres/litres or cups/fluid ounces. Either can be left as
   entered.
2. Preferences belong to the person, not the device: signing in elsewhere
   applies the same units.
3. Changing units never edits a recipe.

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
3. **An export carries recipes, not photos.** A stored photo is referenced
   by a path that only members of its book can read, so a recipe imported
   into another account or book arrives without its picture. Photos held on
   the recipe itself — from a public URL, or from a device while signed out
   — do travel.
4. Import is a bulk operation and does not step through a review of each
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
- Owners cannot leave their own books (J7.6).
- Invite links are reusable until they expire (J7.4).
- Share links never carry photos (J6.2), and exports do not either (J10.3).
- There is no multi-recipe share link (J6.4).
