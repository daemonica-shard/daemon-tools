# web

Browser tools for people rather than for Claude, served at `tools.<domain>`. So far one: the ROAS
payback forecast from [`lib/roas-forecast`](../lib/roas-forecast).

| Path | What |
|------|------|
| `/roas-forecast/` | the forecast page, built from the library's page with no data in it |
| `GET /roas-forecast/api/export` | the latest uploaded export and when it was uploaded (204 before the first) |
| `POST /roas-forecast/api/export` | upload one: `text/csv` body, file name in `X-File-Name` |

An upload is checked with the same reader the page uses, then kept as uploaded. The 10 newest stay
on disk, and the page shows the newest. The file name matters: the page reads the export date from
it.

## No sign-in

Anyone with a page's address can open it, read the export on it and upload a new one. The root
answers 404 and every response tells search engines to stay out, so the address isn't handed out,
but that is all the protection there is. The page renders uploaded text as text only, so a hostile
upload can show wrong numbers but cannot run code in a visitor's browser.

Deploying it is step 15 of [`deploy/SETUP.md`](../deploy/SETUP.md).

## Local

```sh
pnpm --filter @daemon-tools/roas-forecast build
pnpm --filter web dev          # http://localhost:3000/roas-forecast/, uploads in web/data (gitignored)
pnpm --filter web test
```

Uploads are real spend and revenue, and this repo is public: keep `DATA_DIR` out of the repo, or
in the default `web/data`, which git ignores.
