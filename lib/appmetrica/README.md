# @daemon-tools/appmetrica

A client for AppMetrica's [Logs API](https://appmetrica.yandex.com/docs/en/mobile-api/logs/about)
(raw rows: ad impressions, events, sessions, installs …), plus the Management API calls that go
with it. [`jobs/appmetrica-logs`](../../jobs/appmetrica-logs) uses it to download days of logs to
CSV, and the README there explains how to get a token.

```ts
import { AppMetricaClient, DEFAULT_FIELDS } from "@daemon-tools/appmetrica";

const client = new AppMetricaClient({ token: process.env.APPMETRICA_TOKEN! });
const [app] = await client.listApplications();
const file = await client.exportLogs({
  applicationId: app.id,
  table: "ad_revenue_events",
  since: "2026-11-20 00:00:00", // in the app's time zone (app.timeZoneName)
  until: "2026-11-20 23:59:59",
  fields: DEFAULT_FIELDS.ad_revenue_events!,
  dateDimension: "receive",
});
if (file.shardsUnavailable !== 0) console.warn("incomplete: fetch it again later");
const csv = await new Response(file.body).text();
```

`exportLogs` handles the API's queue. It repeats the identical request while AppMetrica prepares
the file (202), waits when the app already has 3 exports queued (429), and retries 5xx answers and
network errors. Things to know as a caller:

- **Check `shardsUnavailable`.** A file with rows missing still comes back as a 200, and only the
  `Shards-Unavailable` header says so: above 0 means fetch it again later. Complete exports come
  without the header, which reads as 0.
- **Check `rows`.** AppMetrica sends the file's row count in a `Rows-Number` header (not in its
  docs). Compare it with what you parsed to catch a cut-off download.
- **Prepared files are reused.** For 24 hours, AppMetrica answers an identical request with the
  same file. Pass `maxAgeSeconds` when you need rows newer than that, such as a day that was still
  filling in the last time you asked.
- **A bad token gets a 403**, with `error_type` `invalid_token`, although the docs say 401.

The token only ever goes in the `Authorization` header, so URLs and error messages are safe to log.
