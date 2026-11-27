import type { LogsTable } from "./client.js";

// Default columns for looking at players one by one: who (device ids), when (device time and
// arrival time), on what (app version, device, country) and the table's own columns.
//
// Left out on purpose: IP addresses, city, android_id, mcc/mnc/operator (nothing here needs them,
// and they are the most personal), and application_id (one value per export). Names come from
// AppMetrica's per-table reference pages. Where the reference and the endpoints overview disagree on
// a name we don't need (android_id, appmetrica_sdk_version on events, original_device_model), it's
// left out.
//
// Field lists: https://appmetrica.yandex.com/docs/en/mobile-api/logs/endpoints

/** The columns every per-player table shares: the device, its ids and the app build. */
const DEVICE = [
  "appmetrica_device_id",
  "profile_id",
  "google_aid",
  "ios_ifa",
  "ios_ifv",
  "os_name",
  "os_version",
  "device_type",
  "device_manufacturer",
  "device_model",
  "device_locale",
  "connection_type",
  "country_iso_code",
  "app_package_name",
  "app_version_name",
] as const;

/**
 * Each table's arrival time, which date_dimension=receive ranges apply to: "yyyy-mm-dd hh:mm:ss" in
 * the app's time zone. A multi-day export can be split into days by its first 10 characters.
 */
export const RECEIVE_DATETIME: Partial<Record<LogsTable, string>> = {
  ad_revenue_events: "ad_revenue_receive_datetime",
  events: "event_receive_datetime",
  revenue_events: "event_receive_datetime",
  sessions_starts: "session_start_receive_datetime",
  installations: "install_receive_datetime",
};

export const DEFAULT_FIELDS: Partial<Record<LogsTable, readonly string[]>> = {
  // One row per impression. ad_revenue is that impression's revenue in ad_revenue_currency, so
  // CPM = ad_revenue × 1000.
  ad_revenue_events: [
    "ad_revenue_datetime",
    "ad_revenue_timestamp",
    "ad_revenue_receive_datetime",
    "ad_revenue_receive_timestamp",
    "ad_revenue",
    "ad_revenue_currency",
    "ad_revenue_type",
    "ad_revenue_data_source",
    "ad_revenue_network",
    "ad_revenue_placement_id",
    "ad_revenue_placement_name",
    "ad_revenue_unit_id",
    "ad_revenue_unit_name",
    "ad_revenue_precision",
    "ad_revenue_payload",
    "session_id",
    "installation_id",
    ...DEVICE,
    "app_build_number",
    "appmetrica_sdk_version",
  ],
  // Custom events. event_json holds the parameters, as the game sent them.
  events: [
    "event_datetime",
    "event_timestamp",
    "event_receive_datetime",
    "event_receive_timestamp",
    "event_name",
    "event_json",
    "session_id",
    "installation_id",
    ...DEVICE,
    "app_build_number",
  ],
  // One row per in-app purchase: reported by the game (reportRevenue) or collected by AppMetrica itself
  // (is_revenue_autocollected). revenue_price is in revenue_currency, which is whatever the game sent: TEL
  // sends the store's local price and currency, before the store's cut. This table has no device_type.
  revenue_events: [
    "event_datetime",
    "event_timestamp",
    "event_receive_datetime",
    "event_receive_timestamp",
    "event_name",
    "revenue_quantity",
    "revenue_price",
    "revenue_currency",
    "revenue_product_id",
    "revenue_order_id",
    "revenue_order_id_source",
    "is_revenue_verified",
    "is_revenue_autocollected",
    "revenue_inapp_type",
    "revenue_event_type",
    "session_id",
    "installation_id",
    ...DEVICE.filter((field) => field !== "device_type"),
    "app_build_number",
    "appmetrica_sdk_version",
  ],
  sessions_starts: [
    "session_start_datetime",
    "session_start_timestamp",
    "session_start_receive_datetime",
    "session_start_receive_timestamp",
    "session_id",
    ...DEVICE,
    "app_build_number",
  ],
  // One row per install, with AppMetrica's own attribution (its trackers, not Adjust's).
  installations: [
    "install_datetime",
    "install_timestamp",
    "install_receive_datetime",
    "install_receive_timestamp",
    "is_reinstallation",
    "is_reattribution",
    "attributed_touch_type",
    "match_type",
    "fingerprint_method",
    "publisher_id",
    "publisher_name",
    "tracker_name",
    "tracking_id",
    "click_datetime",
    "click_timestamp",
    "click_id",
    "click_url_parameters",
    "installation_id",
    ...DEVICE,
    "oaid",
  ],
};
