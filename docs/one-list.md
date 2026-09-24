# One list for the week — design plan

Recipe Friend's plan already answers "what do we need for these recipes". It
cannot hold anything that is not a recipe, so frozen-pizza night and the milk
live in Google Keep and the week is split across two places. This plan makes
the plan the household's **one list**: non-recipe meals, loose list items,
and agent tools for both.

It is the working plan, not the acceptance criteria. The criteria go into
`journeys.md` (J12–J14, J16–J17) the way every other feature's do, and this
file can go once they are there.

Context: this is Phase 04 of the household-agent project in the `homelab`
repo. Phase 05, a meal-planning agent, builds on it — it puts meals in the plan
and last-minute additions on the list, over the MCP server.

---

## Requirements

1. **Non-recipe meals.** A named meal in the plan ("Frozen pizza") that counts
   as one of the week's meals, optionally with list lines of its own.
2. **Loose list items.** Things to buy that belong to no meal (milk, kitchen
   roll), settled with the same ✗ *have* / ✓ *got* as every other line.
3. **Agent tools** to add and remove both, beside `add_to_plan` /
   `remove_from_plan`, with `get_plan` returning them.
4. **Nothing existing weakens.** One live plan per book, the offline two-phone
   merge, the size caps inside the server's 200 000-byte check, viewers unable
   to write, the insert-only archive.
5. **It is good to use in the shop on both phones.** If it is not, Keep stays.

## Decisions

1. **Non-recipe meals do not touch planning history.** They are archived with
   the plan, but `plannedIndex` skips them, so they never appear in "last
   planned", the sorts, or `planning_history`.
2. **Loose items are ephemeral.** They exist only in the live plan, until
   they are settled or the plan is finished or cleared. Nothing carries them
   into the next plan, the archive does not keep them, and there are no
   staples.
3. **A loose item is a line of its own, never combined.** Milk added twice is
   two lines, and milk added by hand is not folded into the 300 ml the
   pancakes want. Whether two of them are one need is for whoever keeps the
   list to decide. When the agent adds something, deciding is its job: it
   reads the list first and adds, combines or leaves it (see *Agent tools*).
4. **The list merges per item between devices; items are not merged with
   each other.** Two phones adding things offline both keep what they added.
   Meals, including non-recipe ones, keep merging whole as J12.11 says.
5. **Done needs at least one meal** — recipe or not — where J14.3 said a
   recipe. A plan that is only loose items is never archived. When everything
   on it is settled, those lines just stay settled until the plan is cleared
   or a meal is added and it is finished.
6. **No plan data version bump, and no rollout choreography.** There are no
   users to protect. `version: 1` and the `:v1` storage key stay as they are.

---

## Data model

```
plan = {
  id, createdAt, updatedAt, completedAt,
  meals: [ {id, recipeId, name, portions, multiplier, addedAt} ],
          // recipeId null → a non-recipe meal: a name, no portions
  items: [ {id, text, mealId, addedAt, state, at} ],
          // mealId null → a loose item; set → one of a non-recipe
          // meal's own lines.
          // state: "" (to buy) | "have" (✗) | "got" (✓) | "removed"
          // at: when state last changed — the item's merge stamp
  settled: { [itemKey]: { have: {amount, at}, got: {amount, at} } }
          // unchanged, and only for recipe lines
}
```

**An item is just text.** It is never summed or converted, so nothing needs
to read an amount out of it: "2 l milk" is the line, as typed. That avoids
writing a free-text ingredient parser, which the app does not have.

**An item settles itself.** Its state lives on the item, not in `settled`.
`settled` is keyed by item name, so two milks there would become one — which
is decision 3 undone by the back door. And a loose line is ticked, not
measured, so it needs no amounts.

**Merging.** Items are a union by `id`. Where both sides hold the same item,
the later `at` wins, with the same one-millisecond-past stamping `settle()`
uses so that a hand cannot tie with itself. Removal is `state: "removed"`,
a stamped state rather than a deletion, so it beats an older copy that still
has the item. Removed items are dropped at the end of the plan's generation,
along with everything else, so they never pile up. A plan with a new id wins
whole, as now, which is also what makes items end with their plan.

**Done** archives the plan with `items` stripped, and starts the empty plan
exactly as today. **Clear** is unchanged.

Code that currently assumes every meal has a recipe, or that the list is
only recipes:

| Where | Today | Change |
|---|---|---|
| `planstore.sanitizeMeal` | drops a meal whose `recipeId` is not a uuid | allow `null`, and require a name |
| `planstore.sanitizePlan` | rebuilds known fields | add `sanitizeItems`; `sanitizeArchived` drops `items` |
| `plan.mergePlans` | meals whole, `settled` per key | add per-item merge of `items` |
| `plan.prune` | drops meals whose recipe left the book | keep recipe-less meals |
| `plan.removeMeal` | removes the meal | also marks the meal's own items removed |
| `plan.plannedIndex` | indexes every meal by `recipeId` | skip recipe-less meals |
| `plan.complete` | needs a meal | unchanged in rule; strip `items` from what is archived |
| `plan.isPlanned`, `factorFor`, `stepPortions` | assume a recipe | no-ops for recipe-less meals, and no stepper |
| `plan.touchedAt` | `updatedAt` and settlements | also item `at`s, so sync pushes a tick |
| `shoplist.build` | recipe lines only | also loose lines; `allSettled` and `finishesShop` count them |
| `shoplist.copyText` | outstanding recipe lines | also outstanding items, as typed |
| `mcp/digest.mealsInBook` | filters to meals with a recipe | keep recipe-less meals |
| `app.js` plan count, empty states, Done/Clear visibility | count `meals` | the rules above |

### Size caps

The caps are arithmetic against the 200 000-byte check (see the top of
`planstore.js`), and `items` needs a share. An item's text is capped at 120
characters, like a meal name. Worked the same way as the existing sum — six
fields, two uuids, 120 characters of text, a short state string and two
numbers — an item comes to about 670 bytes, called 700.

| | cap | bytes each | total |
|---|---|---|---|
| meals | 60 → **40** | 700 | 28 000 |
| items (incl. removed) | **50** | 700 | 35 000 |
| settled | 120 | 1 000 | 120 000 |
| the plan itself | | | 300 |
| | | | **183 300**, 16 700 spare |

The existing test that does this sum gets `items` added.

## The app

- **Plan view, Meals:** an "Add a meal that isn't a recipe" field. A
  non-recipe meal is a row with its name and ×, and no portions stepper,
  since there is no recipe to scale. Its own lines are added under it, with
  the same field as loose items.
- **Plan view, Shopping list:** an **Add to the list** field at the top of the
  list, always there, and working offline. What is typed is the line.
- **Loose lines sit in the one list**, first under *to buy*, since they are
  the ad hoc part. They carry ✗ and ✓ like any line, and "Put back". Where a
  line came from (J13.7) reads the meal's name for a non-recipe meal's lines,
  and nothing for a loose one.
- **A mistyped item** is ✗'d away like any line. There is no separate delete:
  two X-shaped buttons on one row would be worse than a stray line in
  "already have", and the line is gone at the end of the week anyway.
- **The plan opens with nothing in it.** Adding milk must not require turning
  on plan mode and picking a recipe first. The empty-state copy changes to
  match.
- **Viewers** get neither field (J12.10).

### The shop test (requirement 5)

This is part of the phase, not a follow-up. The Phase 05 design shops by Ocado
slot, so "the shop" is probably filling an Ocado basket from a phone as often
as walking an aisle. Over a real week, on both phones, check: adding things
while out, ✓ while filling the basket, Copy/Share, and two people adding at
once. Whatever makes it worse than Keep gets fixed in this phase.

## Agent tools

| Tool | Change |
|---|---|
| `add_to_plan` | A meal is either `{recipeId, portions?/multiplier?}` as now, or `{name, items?}` for a non-recipe meal. |
| `remove_from_plan` | Works for both kinds. Removing a non-recipe meal removes its own lines and reports them. |
| `add_to_list` *(new)* | `items: [{text}]`, up to 20. Returns each `itemId` and the list as it now stands. |
| `remove_from_list` *(new)* | `itemIds`. Returns what was removed, with its text so it can be added back, and `missing`. |
| `get_plan` | Meals gain `recipe: false` for non-recipe meals. `shoppingList` gains `items` — each loose line with `itemId`, `text`, state and meal. |

**The agent does the aggregating** (decision 3). `add_to_list`'s description
says so: read `get_plan` first, and where the item is already on the list —
by hand or from a recipe — decide whether this is more of it, the same need,
or something new, then add, replace (remove and add), or leave it. Nothing on
the server second-guesses that.

All of these follow J17.9, as the existing tools do: read before writing, hold
the book for the write, report what survived rather than what was asked for.
Per-item merge is what makes "survived" the usual answer for list items.

A tool to settle a line ("we already have milk") is permitted by J16.5 and
would suit Phase 05, but nothing here needs it. It stays out until the planner
shows it wants one.

## Order of work

Each step is a PR with its own tests, in the repo's usual style.

1. **Journeys.** Write the decisions and the behaviour above into
   `journeys.md`: amend J12.1, J12.8, J12.11, J13.1, J13.7, J13.13 and
   J14.1–J14.3, add criteria for loose items and non-recipe meals, and put the
   tools in J17.
2. **Model.** `plan.js`, `planstore.js`, `shoplist.js`: the new shapes,
   per-item merge, `items` stripped from the archive, the caps and the size
   test. These are pure functions, so this is where the tests are densest —
   the merge above all: offline adds on both sides, a tick against a removal,
   a stale copy against a removal, and a generation change.
3. **App.** The two fields, the non-recipe meal row, loose lines in the list,
   the empty states, Done and Clear. `app-plan.test.js`. **Milestone:**
   frozen-pizza night and milk sit in the plan and the list, on both phones.
4. **MCP.** The tool changes and `mcp-tools-*.test.js`. **Milestone:** asked
   over Telegram, claw adds a non-recipe meal and a loose item.
5. **Deploy to the lab.** Bump `RECIPE_FRIEND_REF` in the homelab
   `stacks/claw/Dockerfile`, `up -d --build`, and verify.
6. **A real week** shopped from Recipe Friend instead of Keep.
