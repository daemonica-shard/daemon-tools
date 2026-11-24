# appmetrica-logs

Downloads AppMetrica's raw logs as Parquet files: one row per ad impression, custom event, session
start or install, with the device each came from. It's for questions about players one by one, e.g.
what an impression earned, for whom, at which level. AppMetrica's reports only show totals.

It reads the [Logs API](https://appmetrica.yandex.com/docs/en/mobile-api/logs/about) through
[`@daemon-tools/appmetrica`](../../lib/appmetrica).

## Setup: a token

The Logs API takes a Yandex OAuth token with the `appmetrica:read` permission. Do this once, signed
in to a Yandex account that can open the app in AppMetrica:

1. Open <https://oauth.yandex.com/client/new> directly. Opened from Yandex ID, the page hides the
   permission options.
2. Fill in a contact email and a name (e.g. "AppMetrica logs"). Under platforms, choose **Web
   services** and set the Redirect URI to `https://oauth.yandex.com/verification_code`. Under data
   access, choose **appmetrica:read**; this tool never writes. Create the app and copy its
   **ClientID**.
3. Open `https://oauth.yandex.ru/authorize?response_type=token&client_id=<ClientID>` and allow
   access. Yandex sends you back with the token in the page's address, after `#access_token=`;
   the page itself may show nothing. Copy the whole address from the address bar (Safari shows
   only the domain until you click into it).
4. Save the token from the clipboard, so it never shows up in shell history or a chat. This keeps
   only the token, whether the clipboard holds the whole address or the token alone:

   ```sh
   (umask 077; mkdir -p ~/.config/appmetrica && pbpaste | sed -E 's/.*access_token=([^&]+).*/\1/' > ~/.config/appmetrica/token)
   ```

`APPMETRICA_TOKEN` in the environment takes precedence over the file, e.g. for a server job.
Revoked or expired tokens get `403 invalid_token`; get a new one the same way.

## Usage

```sh
pnpm --filter appmetrica-logs... build        # once, and after pulling changes
node jobs/appmetrica-logs/dist/index.js apps  # find the app's id
node jobs/appmetrica-logs/dist/index.js pull --app <id> --out ~/somewhere/appmetrica
node jobs/appmetrica-logs/dist/index.js pull --app <id> --out ~/somewhere/appmetrica --since 2026-10-01
```

`pull` writes one Parquet file per table per day, plus a `.json` beside each one recording how it
was fetched:

```
<out>/<app id>/app.json                               name and time zone
<out>/<app id>/ad_revenue_events/2026-11-20.parquet
<out>/<app id>/ad_revenue_events/2026-11-20.json      rows, columns, sizes, fetched at, final or not
<out>/<app id>/installations/…  sessions_starts/…
```

The default tables are AppMetrica's standard ones: ad impressions with their revenue
(`ad_revenue_events`), installs (`installations`) and session starts (`sessions_starts`). Custom
events (`events`, everything the game logs itself, such as TEL's `ADS_PAYED`) run to over a million
rows a day, so they're only pulled when asked for: `--tables events`.

- **Parquet, because the CSV is huge.** For one game, a day of AppMetrica's CSV was 273 MB of
  impressions and 584 MB of events; as Parquet, 6 MB and 17 MB. Every column is kept as text,
  exactly as AppMetrica sent it, so cast in queries (`ad_revenue::DOUBLE`). Query with DuckDB:

  ```sql
  SELECT ad_revenue_type, count(*) AS impressions, avg(ad_revenue::DOUBLE) * 1000 AS cpm
  FROM read_parquet('<out>/<app id>/ad_revenue_events/*.parquet', union_by_name = true)
  WHERE ad_revenue_data_source = 'manual'
  GROUP BY ALL;
  ```
- **Every file is checked.** AppMetrica sends a row count with each export (the `Rows-Number`
  header, not in its docs), and a day whose file holds a different number is not saved.
- **Re-running is cheap.** Final days are skipped, so a re-run only fetches days that are new or
  not final yet. `--refresh` fetches everything again.
- **Days are by arrival at AppMetrica**, in the app's time zone (the Logs API's
  `date_dimension=receive`). A row then belongs to exactly one day, and a day that's over never
  changes, even when a device that was offline sends old events later. For when something
  happened on the device, read the `*_datetime` column.
- **A day becomes final a full day after it ends.** AppMetrica doesn't say how long it takes before
  received rows can be exported, so until then every run downloads the day again. A day also stays
  partial while `Shards-Unavailable` is above 0, which means AppMetrica couldn't read part of its
  storage. (Complete exports don't send that header at all.)
- **Exports are slow, so up to 3 run at once.** Each export is queued, prepared, then downloaded.
  Preparing takes AppMetrica from a couple of minutes to much longer; downloading takes seconds.
- **Small tables come a month at a time.** Preparing takes about as long for a month as for a day
  (30 days of installs: 4 minutes; a single day once took 11), so installs and session starts are
  requested in runs of up to 31 days and split into days by their arrival time. Impressions stay at
  one day per export, since one day is already ~270 MB of CSV. AppMetrica allows 3 queued exports per app, so an export started
  in the AppMetrica UI at the same time waits for a free slot. `queries --app <id>` lists what's
  queued, and `--cancel` cancels it all.
- **The output folder must be outside this repo**, since the repo is public. The tool refuses
  otherwise.

The columns are in [`lib/appmetrica/src/fields.ts`](../../lib/appmetrica/src/fields.ts). Changing a
table's columns fetches its final days again, so every file of a table has the same columns.

## Reading the data (TEL games)

- **Key players on `appmetrica_device_id`.** `profile_id` is empty because TEL doesn't set a
  profile id in AppMetrica.
- **`*_datetime` columns are in the app's time zone**; `*_timestamp` columns are Unix seconds.
- **`ad_revenue_type` is a number:** 2 banner, 3 rewarded, 4 interstitial, 5 MREC, 6 other. In
  AppMetrica's own AppLovin rows (below), 6 is AppLovin's tablet banner, `LEADER`. TEL reports those
  as banners, since its banner provider labels every impression it shows as a banner.
- **`ad_revenue` is one impression's revenue in USD**, so CPM = `ad_revenue` × 1000. TEL's
  `AdsMetricaModule` sends it from MAX's revenue-paid callback.
- **Keep `ad_revenue_data_source = 'manual'`.** That's TEL's module. Builds that also had
  AppMetrica's own AppLovin collection on sent every impression a second time, as
  `autocollected`. The duplicates follow app versions, not dates, since old builds stay installed.
- **`ad_revenue_precision` is empty in TEL's rows**, because TEL doesn't pass MAX's revenue
  precision. The `autocollected` duplicates do carry it (`exact`, `estimated`, `publisher_defined`),
  along with AppLovin's format name in `ad_revenue_payload`.
- **Installs carry AppMetrica's own attribution** (`publisher_name`, `tracker_name`). For AppLovin
  installs, `click_url_parameters` holds only an `adjust_external_click_id`, not the campaign.
