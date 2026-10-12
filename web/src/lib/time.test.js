import { describe, it, expect } from 'vitest';
import { zonedIso, localTime, localDate, minutesInto, hmToMinutes, addDays, formatDuration, zoneOffsetMinutes } from './time.js';

describe('unit time zone helpers', () => {
  it('turns a Lagos wall-clock time into the right instant', () => {
    expect(zonedIso('2026-10-15', '10:00', 'Africa/Lagos')).toBe('2026-10-15T09:00:00.000Z');
    expect(zonedIso('2026-10-15', '00:30', 'Africa/Lagos')).toBe('2026-10-14T23:30:00.000Z');
  });
  it('handles a zone with daylight saving', () => {
    expect(zonedIso('2026-07-01', '09:00', 'Europe/London')).toBe('2026-07-01T08:00:00.000Z');
    expect(zonedIso('2026-12-01', '09:00', 'Europe/London')).toBe('2026-12-01T09:00:00.000Z');
    expect(zoneOffsetMinutes('2026-07-01T12:00:00Z', 'Europe/London')).toBe(60);
  });
  it('reads instants back in the zone', () => {
    expect(localTime('2026-10-14T23:30:00Z', 'Africa/Lagos')).toBe('00:30');
    expect(localDate('2026-10-14T23:30:00Z', 'Africa/Lagos')).toBe('2026-10-15');
    expect(minutesInto('2026-10-15', '2026-10-15T09:15:00Z', 'Africa/Lagos')).toBe(615);
  });
  it('small helpers', () => {
    expect(hmToMinutes('24:00')).toBe(1440);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(formatDuration(90)).toBe('1 h 30 min');
    expect(formatDuration(45)).toBe('45 min');
  });
});
