---
name: recipe-share-link
description: Turn a recipe from a web page, a photo of a cookbook page, or pasted text into a Recipe Friend share link that opens straight into someone's recipe box. Use when asked to "make a share link", "add this recipe to Recipe Friend", or when handed a recipe URL or image for this app.
---

# Recipe → Recipe Friend share link

A Recipe Friend share link carries the whole recipe compressed inside the
URL's `#` fragment, so it never reaches a server. Opening one shows the
recipient a preview and a **Save to my recipe box** button.

```
https://malfernion.github.io/Recipe-friend/#add=1.<base64url payload>
```

Your job: read a recipe from wherever it lives, write it as JSON in the
app's exact shape, encode it with the script in this skill, verify the link
decodes back, and hand it over.

## Steps

### 1. Get the recipe

**From a web page** — fetch the page and look for a `<script
type="application/ld+json">` block with `"@type": "Recipe"` first. Most
recipe sites publish one, and it gives you clean `recipeIngredient`,
`recipeInstructions`, `recipeYield`, `prepTime` and `cookTime` fields
(ISO-8601 durations like `PT25M`). Fall back to reading the visible page
only if there is no JSON-LD.

**From a photo** — read every ingredient line and every step off the image.
If a line is cut off, blurred, or ambiguous (a torn edge, an amount you
can't make out, a step that continues on a page you weren't given), say so
and ask rather than guessing. A wrong quantity is worse than a missing one.

**When the page won't load** — a blocked domain, a paywall, a login wall, or
a page that renders only in JavaScript. Stop and ask the user to paste the
recipe text or send a screenshot. Do **not** reconstruct the recipe from
what you remember of it, and do not assemble it from search-result snippets
or a different site's version of the same dish: those produce a recipe that
looks right and has the wrong quantities, which is the one outcome worse
than no link at all.

**Never invent content.** If the source gives no servings or no timings,
leave those `null` — do not estimate them.

**Taking one part of a bigger recipe.** Pages often bundle several
components ("For the dirty rice", "For the coleslaw") and a request may be
for just one of them. Then:

- Take only that group's ingredient lines, plus any from the top-level list
  that the component actually uses.
- Take only the method steps for that component — usually one or two
  sentences that name it — and any storage tip that mentions it by name.
- **Name it for what it is, not for the dish it came from.** A plain slaw
  served alongside peri-peri chicken is not "peri-peri coleslaw"; call it a
  coleslaw and put the provenance in the description. Naming it after the
  headline dish misdescribes the food.
- The page's yield covers the whole dish. Carry it across as-is — portion
  scaling keys off it — and don't try to re-derive a yield for the part.
- Timings usually belong to the whole dish too. If none is stated for the
  component alone, leave them `null` rather than apportioning.

### 2. Write `recipe.json`

```json
{
  "name": "Lemon Garlic Roast Chicken",
  "description": "A one-tray roast.",
  "servings": 4,
  "prepMinutes": 20,
  "cookMinutes": 80,
  "ingredients": [
    { "amount": 1.6,  "unit": "kg",    "item": "whole chicken" },
    { "amount": 4,    "unit": "clove", "item": "garlic, crushed" },
    { "amount": 1,    "unit": "",      "item": "lemon, halved" },
    { "amount": null, "unit": "",      "item": "salt and pepper, to taste" }
  ],
  "steps": ["Heat the oven to 200°C.", "Roast for 80 minutes."],
  "tags": ["chicken", "roast"],
  "image": ""
}
```

`example-recipe.json` in this folder is a complete working template.

**Rules the app enforces** — break one and the recipe is silently dropped
when the link is opened, so the encoder script fails loudly on each instead:

| Field | Rule |
| --- | --- |
| `name` | **Required**, non-empty, ≤120 chars |
| `ingredients` | **At least one**; each is `{amount, unit, item}` |
| `steps` | **At least one** non-empty string |
| `amount` | A positive number, or `null` for "to taste" / "a splash". Never `0`, never a string. Write fractions as decimals (`0.5`, not `"1/2"`) |
| `unit` | Short label, ≤24 chars, `""` when the item needs none ("1 lemon") |
| `item` | Required, ≤200 chars. Put preparation here: `"onion, finely sliced"` |
| `description` | Optional, ≤500 chars |
| `servings`, `prepMinutes`, `cookMinutes` | Whole non-negative numbers or `null` |
| `tags` | Lowercase strings, ≤40 chars each |
| `image` | An `http(s)` URL or `""` — see *Photos* below |
| `id` | Omit it. The script mints a UUID (see *Idempotency*) |

**Units.** These ten convert between metric and imperial for the reader:
`g`, `kg`, `oz`, `lb`, `ml`, `l`, `cup`, `fl oz`, `tsp`, `tbsp`. Use them
where the recipe does. Anything else (`clove`, `pinch`, `can`, `bunch`,
`handful`) is fine and scales with portions, but is never converted — the
script prints a note when it sees one, which is informational, not an error.
Long forms like `grams` or `tablespoons` are folded to the short label
automatically.

**Splitting amounts.** "2 x 400g tins of tomatoes" becomes
`{"amount": 800, "unit": "g", "item": "chopped tomatoes (2 tins)"}` — one
number the app can scale, with the packaging noted in the item.

### 3. Encode

```bash
node .claude/skills/recipe-share-link/scripts/recipe-link.mjs recipe.json
# or, without Node:
python3 .claude/skills/recipe-share-link/scripts/recipe_link.py recipe.json
```

Both print the finished link on stdout and a one-line summary on stderr.
They validate first, so any error means fix the JSON, not the link. Add
`--base http://localhost:8000/` when targeting a local copy of the app.

Working outside this repo with no script to hand? The format is: JSON
`{"v":1,"r":{…}}` → raw deflate → base64url (`+`→`-`, `/`→`_`, drop `=`)
→ prefix `1.` → append to `#add=`. Uncompressed payloads with the prefix
`0.` also work if you have no deflate available.

### 4. Verify before you deliver

Always decode your own link and read what comes back:

```bash
node .claude/skills/recipe-share-link/scripts/recipe-link.mjs --decode "<link>"
```

Check the name, the ingredient count, and a couple of amounts against the
source. The scripts already round-trip internally, but this is the step that
catches a link mangled *after* encoding — by a copy, a wrap, or a paste.

### 5. Deliver it

**Only ever paste a link you can see in front of you.** The payload is
~700–2000 characters of base64 with no readable structure, which makes it
the easiest thing in the world to reproduce wrongly — and a single wrong
character makes it unopenable.

Two failures cause this, and the second is the dangerous one:

1. **Retyping or hand-copying it.** Don't. Move it by pipe or by copy, and
   `diff` the two copies if it passes through a file.
2. **Never having seen it at all.** If you redirect the script's output
   (`> link.txt`), the link never appears in your transcript — and writing
   one out from there means inventing plausible-looking base64. `cat` the
   file and copy the link from *that* output, or don't redirect in the first
   place.

So: before pasting a link anywhere, point at the exact tool output it came
from. No output, no link.

Give the user the raw link as text they can click or copy — not wrapped in a
downloadable file, not truncated with an ellipsis, not split across lines,
and not inside `**bold**` or other markup that a client might mangle.

## Things worth knowing

**Photos don't travel.** Recipe photos taken in the app live in private
storage and a share link cannot carry them; a link recipient gets no image.
Only a public `http(s)` image URL survives, in the `image` field — so leave
`image` empty unless the source page has a stable public image you actually
want to hotlink. Never put a `data:` URI in it (the app strips them) and
never set `imagePath`.

**Idempotency.** The recipe's `id` is what stops a link creating duplicates:
opening the same link twice updates the same recipe instead of adding a
second. So reuse the *same* `id` when you regenerate a link for a recipe you
already shared (pass it in the JSON), and use a *new* one — omit `id` and
let the script generate it — for a genuinely different recipe. Ids must be
lowercase UUIDs; anything else is replaced at import and idempotency is
lost.

**The recipient needs to be signed in.** Opening a link while signed out
holds the recipe through the Google sign-in round trip and shows the preview
afterwards, so the link isn't wasted — but there is a sign-in step.

**Anyone with the link has the recipe.** Nothing is sent to a server, but the
link *is* the data. Don't put anything in a recipe you wouldn't hand to a
stranger.

**Length.** Around 700 characters for a short recipe, ~2000 for a long one.
Browsers cope well past that; chat apps that auto-wrap or shorten URLs are
the real risk, which is why step 4 exists.

## Portable version

To teach an agent that doesn't have this repo, paste it steps 1–5 above
along with `scripts/recipe-link.mjs`. The script is self-contained — Node
built-ins only, no dependencies — and encodes the format on its own.
