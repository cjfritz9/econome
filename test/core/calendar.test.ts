import { describe, expect, it } from 'vitest';
import { chooseWeek, nextMonday, todayIn, weekOf, weeksEndingWith } from '../../src/core/calendar.ts';

describe('weekOf', () => {
  it('gives the ISO week, Monday to Sunday', () => {
    expect(weekOf('2026-11-07')).toEqual({ id: '2026-W45', start: '2026-11-02', end: '2026-11-08' });
  });

  it.each([
    ['2026-11-09', '2026-W46'],
    ['2026-01-01', '2026-W01'],
    ['2027-01-01', '2026-W53'],
    ['2026-12-28', '2026-W53'],
    ['2027-01-04', '2027-W01'],
    ['2024-12-30', '2025-W01'],
  ])('puts %s in %s, across year boundaries', (date, id) => {
    expect(weekOf(date).id).toBe(id);
  });
});

describe('nextMonday', () => {
  it.each([
    ['2026-11-08', '2026-11-09'],
    ['2026-11-07', '2026-11-09'],
    ['2026-11-09', '2026-11-16'],
  ])('goes from %s to %s', (date, monday) => {
    expect(nextMonday(date)).toBe(monday);
  });
});

describe('todayIn', () => {
  it("uses the household's time zone, not UTC", () => {
    const lateSaturdayInNewYork = new Date('2026-11-08T03:00:00Z');

    expect(todayIn('America/New_York', lateSaturdayInNewYork)).toBe('2026-11-07');
  });
});

describe('chooseWeek', () => {
  it('defaults to the week starting next Monday', () => {
    expect(chooseWeek('America/New_York', undefined, new Date('2026-11-08T15:00:00Z')).id).toBe('2026-W46');
  });

  it('uses the week of a given date', () => {
    expect(chooseWeek('America/New_York', '2026-11-04').id).toBe('2026-W45');
  });
});

describe('weeksEndingWith', () => {
  it('counts back from the given week', () => {
    const ids = weeksEndingWith(weekOf('2027-01-06'), 3).map((week) => week.id);

    expect(ids).toEqual(['2027-W01', '2026-W53', '2026-W52']);
  });
});
