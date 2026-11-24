# @daemon-tools/applovin

A client for AppLovin's [Reporting API](https://support.applovin.com/en/growth/promoting-your-apps/api/reporting-api):
aggregated stats as CSV. The advertiser report is the UA side, what campaigns spent and what they
bought; the publisher report is the MAX side. [`jobs/applovin-spend`](../../jobs/applovin-spend)
uses it to keep a daily history of ad spend.

```ts
import { AppLovinReporting } from "@daemon-tools/applovin";

const reporting = new AppLovinReporting({ apiKey: process.env.APPLOVIN_REPORT_KEY! });
const csv = await reporting.report({
  reportType: "advertiser",
  start: "2026-11-01", // UTC days
  end: "2026-11-24",
  columns: ["day", "campaign", "country", "impressions", "conversions", "cost"],
});
```

Things to know as a caller:

- **It only reaches back 45 days.** Older days answer 400 ("Start date is beyond our 45 day look
  back period"), so anything you need later has to be saved while it's in the window.
- **Cost comes as text with a dollar sign** (`$12.345678`). `conversions` are installs.
- **The key travels in the URL**, because AppLovin accepts nothing else. The client never puts the
  URL in an error and scrubs the key out of anything the server sends back. Keep the URL out of
  your own logs too.
- **Advertiser reports have no column for the promoted app** (`package_name`, `app_name` are
  rejected), so tell apps apart by campaign name.
