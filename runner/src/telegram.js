// Telegram delivery — to MATT ONLY (fixed chat id from env). This is internal
// delivery of digests, not a client-facing channel; the chat id never comes
// from job content. Absent config → deliver() is a no-op that reports so.
export function makeTelegram({ botToken, chatId, fetchImpl = fetch }) {
  const enabled = Boolean(botToken && chatId);
  return {
    enabled,
    async deliver(text) {
      if (!enabled) return { delivered: false, reason: 'telegram not configured' };
      const chunks = [];
      for (let i = 0; i < text.length; i += 3900) chunks.push(text.slice(i, i + 3900));
      for (const chunk of chunks) {
        const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true }),
        });
        if (!res.ok) return { delivered: false, reason: `telegram ${res.status}` };
      }
      return { delivered: true };
    },
  };
}
