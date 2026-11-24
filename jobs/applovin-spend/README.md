# applovin-spend

Keeps a daily history of AppLovin ad spend: the advertiser report, by day, campaign, country and
platform, with impressions, clicks, installs (`conversions`) and cost. It's the acquisition side
to set against what players earn (see [`appmetrica-logs`](../appmetrica-logs)).

AppLovin only keeps 45 days, so this has to run at least monthly to keep history without gaps.

## Setup

The Reporting API takes the account's **Report Key** (AppLovin dashboard: Account → Keys). Copy
it and save it from the clipboard, so it never shows up in shell history or a chat:

```sh
(umask 077; mkdir -p ~/.config/applovin && pbpaste > ~/.config/applovin/report-key)
```

`APPLOVIN_REPORT_KEY` in the environment takes precedence over the file.

## Usage

```sh
pnpm --filter applovin-spend... build                     # once, and after pulling changes
node jobs/applovin-spend/dist/index.js pull --out ~/somewhere/applovin
```

That fetches the whole 45-day window (two requests, a few seconds) and writes:

```
<out>/advertiser/2026-11-20.csv    that UTC day's rows, as AppLovin sent them
<out>/advertiser/manifest.json     rows and fetch time per day
```

- **Every run overwrites the window.** AppLovin revises recent spend for a few days. Days that have
  left the window keep their last copy.
- **Days are UTC.** AppMetrica's `*_datetime` columns are in the app's time zone, so compare on
  `install_timestamp` converted to a UTC date.
- **Cost is text with a dollar sign** (`$12.345678`), and country codes are lowercase (`us`).
- **There's no app column.** Tell apps apart by campaign name, e.g. by the prefix each game's
  campaigns share.
- **The output folder must be outside this repo**, since the repo is public.

```sql
SELECT upper(Country) AS country, sum(Conversions) AS installs,
       sum(replace(Cost, '$', '')::DOUBLE) / sum(Conversions) AS cpi,
       1000 * sum(replace(Cost, '$', '')::DOUBLE) / sum(Impressions) AS cpm_paid
FROM read_csv('<out>/advertiser/*.csv', union_by_name = true)
WHERE Campaign LIKE '<game prefix>%'
GROUP BY ALL ORDER BY installs DESC;
```
