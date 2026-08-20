// Salience pre-filter (stage 1 of the capture gate): a cheap, dependency-free check
// that drops obvious casual chatter for FREE, so only messages that MIGHT carry a
// durable fact reach the LLM classifier (stage 2, the `capture` jobtype). Recall-biased:
// it only drops high-confidence noise; anything borderline passes through to the LLM.
// Never stores anything itself — it just decides "worth a closer look?".

// A fact-signal = something that makes a message look like it carries durable info:
// a number, money, a date/day, or a decision/commitment verb. One clean alternation:
// a digit, OR a money/percent symbol, OR a word from the list (word-bounded).
const FACT_SIGNAL = /\d|[€$£%]|\b(confirm(ed)?|agree(d)?|decid|sign(ed)?|paid|pay|owe|due|deadline|price|cost|quote|invoice|iban|contract|deal|deposit|wire|transfer|budget|deliver(ed)?|ship|launch|hir(e|ed)|fire|resign|milestone|meeting|call|schedul(e|ed)|book(ed)?|postpone|cancel(led)?|by (mon|tue|wed|thu|fri|sat|sun|next|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i;

/** True if this message is worth sending to the LLM salience classifier.
 *  Drops: commands, very short lines, pure short questions with no fact signal. */
export function looksImportant(text) {
  const t = String(text || '').trim();
  if (t.length < 12) return false;            // greetings / "ok" / "thanks" / emoji
  if (t.startsWith('/')) return false;        // a command, handled elsewhere
  // A short pure question with no fact signal is casual ("what's the status?").
  if (t.length <= 80 && t.endsWith('?') && !FACT_SIGNAL.test(t)) return false;
  return FACT_SIGNAL.test(t);
}
