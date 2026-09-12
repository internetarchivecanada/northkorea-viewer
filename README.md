# North Korea Explorer — serverless edition

The North Korean web, 2016 to 2024, as the Wayback Machine preserved it: a time scrubber
over every month of captures, a map of 43 sites sized by how much of each survives, a
serendipity walk from page to page, and search. No server: this is one static page that
reads JSON baked from the explorer's database and a SQLite catalog it downloads once from
an archive.org item and queries in your browser.

**→ https://internetarchivecanada.github.io/northkorea-viewer/**

The full edition, with body-text search over every page, runs at
<https://wayback-labs.sf.archive.org/collection-explorer/>. Links work in both:
`?m=2017-11`, `?view=sites&host=kcna.kp`, `?view=search&q=Hwasong`, `?page=<id>`.

## How it works

| | |
| --- | --- |
| Timeline, sites | `data/*.json`, baked from Postgres by `build_data.py` |
| Pages to open, wander and search | `catalog.sqlite.gz` from [archive.org/details/northkorea-explorer-data](https://archive.org/details/northkorea-explorer-data): the 50 most-captured pages of every site and month plus every screenshotted page, searched by headline |
| Screenshots | zips on the same item, one file at a time via `archive.org/download/<item>/<zip>/<path>` |
| SQL engine | official [SQLite WASM](https://sqlite.org/wasm) build, vendored in `vendor/` |
| Cache | the catalog is kept in IndexedDB, keyed by its build date |

Source of both editions: [internetarchivecanada/northkorea](https://github.com/internetarchivecanada/northkorea)
(private). This repository holds only the published files; edit `serverless/site/` there and
run `serverless/deploy.sh`.

## Caveats

- **Search covers headlines**, not the text of pages. It is a substring match, so Korean
  particles and Chinese compounds are found without word boundaries.
- **Publication dates are inferred** from the page or its address, else from the month it
  first appeared in the archive.
- **The catalog is a snapshot.** The server edition keeps harvesting; this edition is
  rebuilt from it.
- Source: [Archive-It collection 6777](https://archive.org/details/ArchiveIt-Collection-6777).
