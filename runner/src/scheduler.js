// Recurring jobs from one config file (config/schedule.json). A tick computes,
// in the configured timezone, which entries are due today (or this hour) and
// enqueues them idempotently via schedule_key — a restart or a late boot never
// double-enqueues and still catches up the same day/hour.
import fs from 'node:fs';

export function localParts(now, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hhmm: `${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}`,
    hour: get('hour') === '24' ? '00' : get('hour'),
    minute: get('minute'),
    weekday: get('weekday').toLowerCase(), // 'mon'...'sun'
  };
}

/** Which entries are due at `now` and not yet enqueued → [{entry, schedule_key}] */
export function dueEntries(schedule, now) {
  const tz = schedule.timezone || 'Europe/Ljubljana';
  const local = localParts(now, tz);
  const due = [];
  for (const e of schedule.entries || []) {
    if (e.enabled === false) continue;
    if (e.days && !e.days.map((d) => d.toLowerCase()).includes(local.weekday)) continue;
    if (e.everyMinutes && e.everyMinutes > 0 && e.everyMinutes < 60) {
      // Fire at each N-minute slot within the hour (keyed by slot → idempotent).
      const slot = Math.floor(Number(local.minute) / e.everyMinutes) * e.everyMinutes;
      due.push({ entry: e, schedule_key: `${e.id}:${local.date}T${local.hour}:${String(slot).padStart(2, '0')}` });
    } else if (e.every === 'hour') {
      const minute = String(e.minute ?? 0).padStart(2, '0');
      if (local.minute >= minute) due.push({ entry: e, schedule_key: `${e.id}:${local.date}T${local.hour}` });
    } else {
      if (!e.time) continue;
      if (local.hhmm >= e.time) due.push({ entry: e, schedule_key: `${e.id}:${local.date}` });
    }
  }
  return due;
}

export function makeScheduler({ store, schedulePath, log = console.error }) {
  function loadSchedule() {
    return JSON.parse(fs.readFileSync(schedulePath, 'utf8'));
  }

  async function tick(now = new Date()) {
    const schedule = loadSchedule();
    const enqueued = [];
    for (const { entry, schedule_key } of dueEntries(schedule, now)) {
      const job = await store.createJob({
        project: entry.project,
        type: entry.type,
        prompt: entry.prompt ?? entry.type,
        priority: entry.priority ?? 0,
        schedule_key,
      }, 'scheduler');
      if (job) enqueued.push(schedule_key); // null = this occurrence already exists
    }
    return enqueued;
  }

  return {
    tick,
    start(intervalSec = 60) {
      const t = setInterval(() => tick().catch((e) => log(`scheduler tick failed: ${e.message}`)), intervalSec * 1000);
      tick().catch(() => {});
      return () => clearInterval(t);
    },
  };
}
