# 🍲 Recipe Friend

A personal recipe box that lives entirely in your browser. No accounts, no
server, no database — recipes are persisted locally with `localStorage`, and
the site is plain HTML/CSS/JS so it deploys straight to GitHub Pages with no
build step.

## Features

- **Add, edit, and delete recipes** — name, description, servings, prep/cook
  times, ingredients, steps, and tags.
- **Photos** — attach an image from your device (automatically downscaled to
  fit browser storage) or link one by URL.
- **Search and filter** — full-text search across names, ingredients, and
  tags; filter by tag or favorites.
- **Favorites** — star the recipes you keep coming back to.
- **Local persistence** — everything is saved in your browser under a
  versioned `localStorage` key (`recipe-friend:v1`), so your recipes survive
  page reloads and browser restarts.
- **Export / import** — download your whole collection as JSON for backup, or
  import it on another device. Imports merge by recipe id, so re-importing
  never creates duplicates.
- **Dark mode** — follows your system preference.

## Running locally

No tooling required — it's a static site:

```bash
# from the repo root, any static file server works, e.g.:
python3 -m http.server 8000
# then open http://localhost:8000
```

Or just open `index.html` directly in a browser.

## Deploying to GitHub Pages

The included workflow (`.github/workflows/deploy-pages.yml`) deploys the site
on every push to `main`. One-time setup:

1. In the repository, go to **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Push to `main` (or run the workflow manually from the Actions tab).

The site will be published at `https://<username>.github.io/Recipe-friend/`.

## Project structure

```
index.html                     App shell and dialogs
css/styles.css                 Styling (light + dark themes)
js/storage.js                  RecipeStore — localStorage persistence layer
js/app.js                      UI: rendering, search/filter, dialogs, import/export
.github/workflows/deploy-pages.yml   GitHub Pages deployment
```

## Notes on storage

Recipes are stored only in the browser you use — they don't sync between
devices or browsers. Use **Export** regularly to back up your collection, and
**Import** to restore it or move it elsewhere. Clearing site data for the page
will delete your recipes.
