#!/usr/bin/env python3
"""recipe_link.py — Python twin of recipe-link.mjs, for agents without Node.

Same format as js/share.js: JSON -> raw deflate -> base64url, in the URL
fragment. Validation is loud so a recipe the app would reject fails here.

    python3 recipe_link.py recipe.json
    python3 recipe_link.py --decode "<link>"
    python3 recipe_link.py recipe.json --base https://example.com/app/
"""
import base64
import json
import re
import sys
import uuid
import zlib

DEFAULT_BASE = "https://malfernion.github.io/Recipe-friend/"
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
HTTP_RE = re.compile(r"^https?://", re.I)
KNOWN_UNITS = {"g", "kg", "oz", "lb", "ml", "l", "cup", "fl oz", "tsp", "tbsp"}


def fail(message):
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def b64url(raw):
    return base64.b64encode(raw).decode().replace("+", "-").replace("/", "_").rstrip("=")


def unb64url(text):
    text = text.replace("-", "+").replace("_", "/")
    return base64.b64decode(text + "=" * (-len(text) % 4))


def validate(recipe):
    problems = []
    name = str(recipe.get("name") or "").strip()
    if not name:
        problems.append("name is required")
    if len(name) > 120:
        problems.append("name exceeds 120 characters")
    if len(str(recipe.get("description") or "").strip()) > 500:
        problems.append("description exceeds 500 characters")

    ingredients = recipe.get("ingredients")
    if not isinstance(ingredients, list) or not ingredients:
        problems.append("at least one ingredient is required")
    else:
        for i, ing in enumerate(ingredients):
            at = f"ingredients[{i}]"
            if not isinstance(ing, dict):
                problems.append(f"{at} must be an object")
                continue
            if "amount" not in ing:
                problems.append(f'{at}.amount is missing (use null for "to taste")')
            amount = ing.get("amount")
            if amount is not None and not (isinstance(amount, (int, float))
                                           and not isinstance(amount, bool) and amount > 0):
                problems.append(f"{at}.amount must be a positive number or null")
            if not isinstance(ing.get("unit", ""), str):
                problems.append(f'{at}.unit must be a string ("" for none)')
            elif len(ing.get("unit", "")) > 24:
                problems.append(f"{at}.unit exceeds 24 characters")
            if not str(ing.get("item") or "").strip():
                problems.append(f"{at}.item is required")
            if len(str(ing.get("item") or "").strip()) > 200:
                problems.append(f"{at}.item exceeds 200 characters")

    steps = recipe.get("steps")
    if not isinstance(steps, list) or not [s for s in steps if str(s).strip()]:
        problems.append("at least one step is required")

    for key in ("servings", "prepMinutes", "cookMinutes"):
        value = recipe.get(key)
        if value is None:
            continue
        if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0:
            problems.append(f"{key} must be a non-negative number or null")

    tags = recipe.get("tags")
    if tags is not None:
        if not isinstance(tags, list):
            problems.append("tags must be an array of strings")
        elif any(len(str(t).strip()) > 40 for t in tags):
            problems.append("a tag exceeds 40 characters")

    image = str(recipe.get("image") or "").strip()
    if image and not HTTP_RE.match(image):
        problems.append("image must be an http(s) URL — data: URIs are stripped by the app")
    if recipe.get("imagePath"):
        problems.append("imagePath cannot travel in a share link (stored photos are private)")

    if "id" in recipe and not UUID_RE.match(str(recipe["id"])):
        problems.append("id must be a lowercase UUID (or omitted so one is generated)")

    if problems:
        fail("this recipe would not import:\n  - " + "\n  - ".join(problems))


def warn(recipe):
    for i, ing in enumerate(recipe["ingredients"]):
        unit = str(ing.get("unit") or "").strip()
        if unit and unit.lower() not in KNOWN_UNITS:
            print(
                f'note: ingredients[{i}].unit "{unit}" is not a convertible unit — '
                "it scales with portions but is never converted between metric and imperial.",
                file=sys.stderr,
            )


def encode(recipe, base):
    image = str(recipe.get("image") or "").strip()
    payload = {
        "v": 1,
        "r": {
            "id": recipe.get("id") or str(uuid.uuid4()),
            "name": recipe["name"].strip(),
            "description": str(recipe.get("description") or "").strip(),
            "servings": recipe.get("servings"),
            "prepMinutes": recipe.get("prepMinutes"),
            "cookMinutes": recipe.get("cookMinutes"),
            "ingredients": [
                {
                    "amount": ing.get("amount"),
                    "unit": str(ing.get("unit") or "").strip(),
                    "item": str(ing["item"]).strip(),
                }
                for ing in recipe["ingredients"]
            ],
            "steps": [str(s).strip() for s in recipe["steps"] if str(s).strip()],
            "tags": [str(t).strip().lower() for t in (recipe.get("tags") or []) if str(t).strip()],
            "image": image if HTTP_RE.match(image) else "",
        },
    }
    text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    compressor = zlib.compressobj(9, zlib.DEFLATED, -15)  # -15 = raw deflate
    raw = compressor.compress(text.encode("utf-8")) + compressor.flush()
    return f"{base}#add=1.{b64url(raw)}", payload["r"]["id"], len(text.encode("utf-8"))


def decode(link):
    blob = link.split("#add=")[1] if "#add=" in link else link
    mark, body = blob[:2], blob[2:]
    if mark not in ("1.", "0."):
        fail(f'unknown payload marker "{mark}" — expected "1." or "0."')
    try:
        raw = unb64url(body)
        text = zlib.decompress(raw, -15).decode("utf-8") if mark == "1." else raw.decode("utf-8")
    except Exception as err:  # truncated copy, inserted line break, retyped character
        fail(f"could not decode this link ({err}) — it is corrupt or incomplete")
    payload = json.loads(text)
    if not isinstance(payload, dict) or payload.get("v") != 1 or not isinstance(payload.get("r"), dict):
        fail("payload is not a v1 recipe share")
    return payload["r"]


def main():
    args = sys.argv[1:]
    if not args:
        print("usage: recipe_link.py <recipe.json> [--base URL] | --decode <link>", file=sys.stderr)
        sys.exit(2)

    if args[0] == "--decode":
        if len(args) < 2:
            fail("--decode needs a link or payload")
        print(json.dumps(decode(args[1]), indent=2, ensure_ascii=False))
        return

    base = DEFAULT_BASE
    if "--base" in args:
        index = args.index("--base")
        if index + 1 >= len(args):
            fail("--base needs a URL")
        base = args[index + 1]

    try:
        with open(args[0], encoding="utf-8") as handle:
            recipe = json.load(handle)
    except OSError as err:
        fail(f"could not read {args[0]}: {err}")
    except json.JSONDecodeError as err:
        fail(f"{args[0]} is not valid JSON: {err}")

    validate(recipe)
    warn(recipe)
    url, recipe_id, size = encode(recipe, base)

    # Round-trip before handing the link over.
    back = decode(url)
    if back["name"] != recipe["name"].strip() or len(back["ingredients"]) != len(recipe["ingredients"]):
        fail("round-trip check failed — the encoded link does not decode back to this recipe")

    print(f"ok: {size} bytes of JSON, {len(url)}-character link, recipe id {recipe_id}",
          file=sys.stderr)
    print(url)


if __name__ == "__main__":
    main()
