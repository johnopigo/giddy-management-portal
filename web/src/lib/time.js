// Times are stored as instants; the schedule is read and entered in the unit's own time zone,
// whatever time zone the browser happens to be in.

function parts(instant, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** Minutes the zone is ahead of UTC at that instant. */
export function zoneOffsetMinutes(instant, timeZone) {
  const p = parts(instant, timeZone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(new Date(instant).getTime() / 1000) * 1000) / 60000);
}

/** ISO instant for a local date ('2026-10-15') and time ('14:30') in the zone. */
export function zonedIso(date, hhmm, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - zoneOffsetMinutes(guess, timeZone) * 60000;
  // Second pass settles instants near an offset change.
  return new Date(guess - zoneOffsetMinutes(first, timeZone) * 60000).toISOString();
}

/** '14:30' for an instant, in the zone. */
export function localTime(instant, timeZone) {
  const p = parts(instant, timeZone);
  return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}

/** '2026-10-15' for an instant, in the zone. */
export function localDate(instant, timeZone) {
  const p = parts(instant, timeZone);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Minutes from the start of local `date` to the instant (may be < 0 or > 1440 for other days). */
export function minutesInto(date, instant, timeZone) {
  return Math.round((new Date(instant).getTime() - new Date(zonedIso(date, '00:00', timeZone)).getTime()) / 60000);
}

/** '10:00' → 600; '24:00' → 1440. */
export function hmToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export const todayIn = (timeZone) => localDate(Date.now(), timeZone);

export function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const longDate = (date) => new Date(`${date}T12:00:00Z`)
  .toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export function formatDuration(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ') || '0 min';
}
