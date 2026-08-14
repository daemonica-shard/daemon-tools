// Notification channels shared by the scheduled jobs. CI sends its own notifications inline in
// build-unity.yml: it is a reusable workflow running in the *game* repo's checkout, so nothing
// from this repo is on disk there, and the shared part is two curl calls.

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export interface PachcaConfig {
  webhookUrl: string;
}

export interface NotifyConfig {
  telegram?: TelegramConfig;
  pachca?: PachcaConfig;
}

export interface NotifyResult {
  channel: "telegram" | "pachca";
  /** false means the channel wasn't configured — skipped, not failed. */
  sent: boolean;
}

// Both channels carry their credential in the URL — Telegram's bot token as a path segment,
// Pachca's webhook URL in its entirety. fetch includes the URL in network error messages, so
// errors are rewritten rather than propagated, or a job's logs leak the secret that lets anyone
// post to your team's chat.
async function post(url: string, body: unknown, channel: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`${channel} request failed: ${(err as Error).cause ?? (err as Error).name}`);
  }
  if (!res.ok) throw new Error(`${channel} responded ${res.status}`);
}

/**
 * Sends to every configured channel. An unconfigured channel is skipped rather than failing, so a
 * job still does its real work on a machine that was never given the secrets — the same gate CI
 * uses. A configured channel that errors *does* throw: silence there would be indistinguishable
 * from "nothing to report".
 */
export async function send(text: string, config: NotifyConfig): Promise<NotifyResult[]> {
  const results: NotifyResult[] = [];

  if (config.telegram) {
    // Plain text, no parse_mode: Telegram's Markdown parsers reject unescaped `-`, `.` and `(`,
    // which appear in almost every generated message.
    await post(
      `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`,
      { chat_id: config.telegram.chatId, text, disable_web_page_preview: true },
      "telegram",
    );
    results.push({ channel: "telegram", sent: true });
  } else {
    results.push({ channel: "telegram", sent: false });
  }

  if (config.pachca) {
    await post(config.pachca.webhookUrl, { message: text }, "pachca");
    results.push({ channel: "pachca", sent: true });
  } else {
    results.push({ channel: "pachca", sent: false });
  }

  return results;
}

/** Reads the same variable names CI uses, so one bot serves both. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): NotifyConfig {
  const config: NotifyConfig = {};
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    config.telegram = { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID };
  }
  if (env.PACHCA_WEBHOOK_URL) {
    config.pachca = { webhookUrl: env.PACHCA_WEBHOOK_URL };
  }
  return config;
}
