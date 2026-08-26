---
name: recipe-share-link
description: Turn a recipe into a Recipe Friend share link — a URL that opens straight into someone's recipe box. Use when asked to make a share link or add a recipe to Recipe Friend, given a recipe URL, a photo, or pasted text.
---

# Recipe Friend share links

Reading a recipe and pulling out its amounts is your job already. This
covers only what you can't work out from the recipe: the shape the app
wants, and how a link is built.

A link carries the whole recipe compressed in the URL's `#` fragment, so
nothing is uploaded anywhere. Opening one shows a preview and a **Save to my
recipe box** button.

## The JSON

```json
{
  "name": "Coleslaw",
  "description": "",
  "servings": 4,
  "prepMinutes": null,
  "cookMinutes": null,
  "ingredients": [
    { "amount": 250,  "unit": "g",    "item": "white cabbage, finely shredded" },
    { "amount": 3,    "unit": "tbsp", "item": "light mayonnaise" },
    { "amount": null, "unit": "",     "item": "salt and pepper, to taste" }
  ],
  "steps": ["Mix everything together in a bowl."],
  "tags": ["side"]
}
```

**What the app silently drops.** A recipe breaking any of these imports as
nothing at all, so the encoder below fails loudly on each instead:

- a `name`, at least one ingredient and at least one step are all required
- `amount` is a positive number or `null` for "to taste" — never `0`, and
  halves are `0.5`, never `"1/2"`
- `unit` is `""` when there isn't one. `g`, `kg`, `oz`, `lb`, `ml`, `l`,
  `cup`, `fl oz`, `tsp`, `tbsp` are converted to whatever units the reader
  prefers; anything else (`clove`, `pinch`, `can`) is kept as written
- `image` only takes a public `http(s)` URL. Photos stored in the app are
  private and can't travel in a link, so normally leave it out

## Build the link

```bash
python3 .claude/skills/recipe-share-link/scripts/recipe_link.py recipe.json
```

It validates, encodes, decodes its own output to check it, and prints the
link. `--decode "<link>"` reads one back.

**Copy the link from that output.** If you redirected it to a file, `cat` the
file and copy it from there — a payload you never saw printed is one you'd
be inventing, and it will look perfectly plausible.

## Idempotency

The `id` is what stops a link creating duplicates: open the same link twice
and it updates the same recipe. Omit `id` and the script mints one. To
correct a recipe you already shared, pass the same `id` back in.

## Chatbots that can't run code

Most can't, so they cannot produce a link at all — asked to, they invent a
plausible one. The app handles that case itself: **Get help from AI** hands
out a prompt asking only for JSON, and the assistant returns that JSON plus
`https://malfernion.github.io/Recipe-friend/#paste`, a deep link to the box
it goes into. Point someone there rather than at this script.

Either way — a link from this script or a paste — the recipe opens in the
edit form first, so it can be renamed or corrected before it is saved.
