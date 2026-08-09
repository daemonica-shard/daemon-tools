// Same bot and chat as the CI build notifications (see .github/workflows/build-unity.yml), and the
// same gate: either variable unset means notification is skipped rather than failed, so the job
// still archives on a machine that was never given the secrets.
export async function sendTelegram(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;

  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
  } catch (err) {
    // The request URL embeds the bot token, and fetch puts the URL in its error message.
    throw new Error(`Telegram request failed: ${(err as Error).cause ?? (err as Error).name}`);
  }

  if (!res.ok) throw new Error(`Telegram responded ${res.status}: ${await res.text()}`);
  return true;
}
