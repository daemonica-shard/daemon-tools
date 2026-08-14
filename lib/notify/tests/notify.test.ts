import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv, send } from "../src/notify.js";

const TOKEN = "123456:SECRET-BOT-TOKEN";
const WEBHOOK = "https://api.pachca.com/webhooks/SECRET-WEBHOOK-PATH";

afterEach(() => vi.unstubAllGlobals());

describe("configFromEnv", () => {
  it("skips telegram unless both variables are present", () => {
    expect(configFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN }).telegram).toBeUndefined();
    expect(configFromEnv({ TELEGRAM_CHAT_ID: "1" }).telegram).toBeUndefined();
    expect(configFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "1" }).telegram)
      .toEqual({ botToken: TOKEN, chatId: "1" });
  });
});

describe("send", () => {
  it("reports unconfigured channels as skipped rather than failing", async () => {
    const results = await send("hello", {});
    expect(results).toEqual([
      { channel: "telegram", sent: false },
      { channel: "pachca", sent: false },
    ]);
  });

  it("posts plain text with no parse_mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await send("a - b (c). d", { telegram: { botToken: TOKEN, chatId: "42" } });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ chat_id: "42", text: "a - b (c). d" });
    // Telegram's Markdown parsers reject unescaped `-`, `.` and `(`, which generated messages
    // are full of. Sending without parse_mode is the reason those characters are safe.
    expect(body).not.toHaveProperty("parse_mode");
  });

  // Both channels put their credential in the URL, and fetch includes the URL in network errors.
  // A job's logs are not a place for the token that lets anyone post to the team chat.
  it("never leaks the credential when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    await expect(send("x", { telegram: { botToken: TOKEN, chatId: "1" } }))
      .rejects.toThrow(/telegram request failed/);
    await expect(send("x", { telegram: { botToken: TOKEN, chatId: "1" } }))
      .rejects.not.toThrow(new RegExp(TOKEN));

    await expect(send("x", { pachca: { webhookUrl: WEBHOOK } }))
      .rejects.not.toThrow(/SECRET-WEBHOOK-PATH/);
  });

  it("does not leak the credential on a non-2xx response either", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await expect(send("x", { pachca: { webhookUrl: WEBHOOK } }))
      .rejects.not.toThrow(/SECRET-WEBHOOK-PATH/);
  });
});
