// Read-only CalDAV client for the owner's Nextcloud calendar hub (deterministic
// runner-side pre-step for the daily brief). The app-password stays here —
// never in a job's env or prompt; it is registered with the redactor.
// Coverage honesty: expected-but-missing calendars are REPORTED, never guessed.

const ICS_UNESCAPE = (s) => s.replace(/\\n/gi, ' · ').replace(/\\([,;\\])/g, '$1').trim();

/** Unfold ICS lines (RFC 5545 §3.1) then extract VEVENTs (minimal fields). */
export function parseIcsEvents(ics) {
  const lines = ics.replace(/\r\n[ \t]/g, '').replace(/\r/g, '').split('\n');
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur?.start) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const m = line.match(/^(SUMMARY|DTSTART|DTEND|LOCATION|RRULE)(;[^:]*)?:(.*)$/);
    if (!m) continue;
    const [, key, params, value] = m;
    if (key === 'SUMMARY') cur.summary = ICS_UNESCAPE(value);
    if (key === 'LOCATION') cur.location = ICS_UNESCAPE(value);
    if (key === 'RRULE') cur.rrule = value.trim();
    if (key === 'DTSTART' || key === 'DTEND') {
      const field = key === 'DTSTART' ? 'start' : 'end';
      cur[field] = value.trim();
      if (params?.includes('VALUE=DATE') || /^\d{8}$/.test(value.trim())) cur.allDay = true;
    }
  }
  return events;
}

/** "20260729T063000Z" | "20260729" → ISO-ish string for sorting/display. */
export function icsTimeToIso(v) {
  const m = String(v).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return String(v);
  const [, y, mo, d, h, mi, s, z] = m;
  return h ? `${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}${z ?? ''}` : `${y}-${mo}-${d}`;
}

export function makeCaldav({ baseUrl, user, pass, fetchImpl = fetch }) {
  const enabled = Boolean(baseUrl && user && pass);
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  async function dav(url, method, body, depth) {
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: auth,
        Depth: depth,
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body,
    });
    if (!res.ok && res.status !== 207) throw new Error(`caldav ${method} → ${res.status}`);
    return res.text();
  }

  return {
    enabled,

    /** Calendar collections under the principal: [{href, name}] */
    async listCalendars() {
      const xml = await dav(baseUrl, 'PROPFIND',
        `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>`, '1');
      const out = [];
      for (const m of xml.matchAll(/<d:response>([\s\S]*?)<\/d:response>/g)) {
        const block = m[1];
        // Local calendars are <cal:calendar/>; read-only subscriptions (the
        // Google/M365 feeds in the NC hub) are <cs:subscribed/>. Take both.
        if (!/resourcetype>[\s\S]*?:(calendar|subscribed)\s*\/?>/i.test(block)) continue;
        const href = block.match(/<d:href>([^<]+)<\/d:href>/)?.[1];
        const name = block.match(/<d:displayname>([^<]*)<\/d:displayname>/)?.[1] ?? '';
        if (href && !href.endsWith('/calendars/') && !/\/(inbox|outbox|trash)/.test(href)) out.push({ href, name });
      }
      return out;
    },

    /** Events in [startIso, endIso) across all calendars, sorted by start.
     *  Returns {events, calendars, errors} — a failing calendar is an error entry, not a guess. */
    async eventsBetween(start, end) {
      const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      const body = `<?xml version="1.0"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
    <c:time-range start="${fmt(start)}" end="${fmt(end)}"/>
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;
      const calendars = await this.listCalendars();
      const events = [];
      const errors = [];
      const origin = new URL(baseUrl).origin;
      const startIso = start.toISOString();
      const endIso = end.toISOString();
      const recurring = []; // RRULE masters — NOT expanded (no fake occurrence math); reported as-is
      for (const cal of calendars) {
        try {
          let icsBlobs = [];
          try {
            const xml = await dav(origin + cal.href, 'REPORT', body, '1');
            icsBlobs = [...xml.matchAll(/<cal:calendar-data[^>]*>([\s\S]*?)<\/cal:calendar-data>/gi)]
              .map((m) => m[1].replace(/&#13;/g, '\r').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
          } catch {
            icsBlobs = [];
          }
          if (!icsBlobs.length) {
            // Subscribed calendars (the Google/M365 feeds) answer calendar-query
            // with an EMPTY multistatus — fetch the full ICS export instead and
            // filter by time range locally.
            const res = await fetchImpl(origin + cal.href + '?export', { headers: { Authorization: auth } });
            if (!res.ok) throw new Error(`export → ${res.status}`);
            icsBlobs = [await res.text()];
          }
          for (const ics of icsBlobs) {
            for (const ev of parseIcsEvents(ics)) {
              const evStart = icsTimeToIso(ev.start);
              if (ev.rrule && evStart < startIso.slice(0, 16)) {
                // Recurring series started in the past: an occurrence may fall in
                // range but we don't expand rules — surface it honestly instead.
                const until = ev.rrule.match(/UNTIL=(\d{8})/)?.[1];
                if (!until || `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}` >= startIso.slice(0, 10)) {
                  recurring.push({ calendar: cal.name || cal.href, summary: ev.summary ?? '(no title)',
                    seriesStart: evStart, rrule: ev.rrule, note: 'recurring — occurrence times not expanded' });
                }
                continue;
              }
              // Compare on normalized "YYYY-MM-DD..." prefixes; date-only events
              // compare on the date part. Rough but honest — no tz math games.
              const key = evStart.slice(0, 16);
              if (key < startIso.slice(0, 16) && !evStart.startsWith(startIso.slice(0, 10))) continue;
              if (key >= endIso.slice(0, 16)) continue;
              events.push({ calendar: cal.name || cal.href, summary: ev.summary ?? '(no title)',
                start: evStart, end: ev.end ? icsTimeToIso(ev.end) : null,
                allDay: Boolean(ev.allDay), location: ev.location });
            }
          }
        } catch (e) {
          errors.push(`${cal.name || cal.href}: ${e.message}`);
        }
      }
      events.sort((a, b) => String(a.start).localeCompare(String(b.start)));
      return { events, recurring: recurring.slice(0, 40),
        calendars: calendars.map((c) => ({ name: c.name || c.href, href: c.href })), errors };
    },
  };
}
