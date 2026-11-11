import dayjs from 'dayjs';
import { DAY_NAMES } from '../../models/WeekoffCategory.js';

/**
 * Week of month (1-5) for a date — first occurrence week starts on 1st.
 */
export function weekOfMonth(date) {
  const d = dayjs(date);
  return Math.ceil(d.date() / 7);
}

export function dayName(date) {
  return DAY_NAMES[dayjs(date).day()];
}

/**
 * Build map of YYYY-MM-DD -> 'W' | 'H' for a staff month.
 * Week-off wins over holiday.
 */
export function buildWHMap({ monthYear, weekOffCategory, holidays = [], joiningDate }) {
  const start = dayjs(`${monthYear}-01`).startOf('month');
  const end = start.endOf('month');
  const holidaySet = new Set(
    (holidays || []).map((h) => dayjs(h.date).format('YYYY-MM-DD'))
  );
  const weekOff = weekOffCategory?.weekOff || {};
  const map = {};

  for (let d = start; d.isBefore(end) || d.isSame(end, 'day'); d = d.add(1, 'day')) {
    const key = d.format('YYYY-MM-DD');
    if (joiningDate && d.isBefore(dayjs(joiningDate), 'day')) {
      map[key] = 'L'; // pre-join = LOP (caller may override)
      continue;
    }
    const weekKey = `week${weekOfMonth(d)}`;
    const offs = (weekOff[weekKey] || []).map((x) => String(x).toUpperCase());
    if (offs.includes(dayName(d))) {
      map[key] = 'W';
    } else if (holidaySet.has(key)) {
      map[key] = 'H';
    }
  }
  return map;
}

/**
 * Seed attendance rows for days that have W/H (or L for pre-join).
 * Does not overwrite existing statuses.
 */
export function seedAttendanceRows({ monthYear, staffId, userId, hotelId, weekOffCategory, holidays, joiningDate }) {
  const map = buildWHMap({ monthYear, weekOffCategory, holidays, joiningDate });
  const start = dayjs(`${monthYear}-01`).startOf('month');
  const end = start.endOf('month');
  const rows = [];

  for (let d = start; d.isBefore(end) || d.isSame(end, 'day'); d = d.add(1, 'day')) {
    const key = d.format('YYYY-MM-DD');
    const status = map[key];
    if (!status) continue;
    rows.push({
      hotelId,
      staffId,
      userId,
      attendanceDate: d.toDate(),
      status
    });
  }
  return rows;
}

export function summarizeAttendance(rows, monthYear, joiningDate) {
  const start = dayjs(`${monthYear}-01`).startOf('month');
  const daysInMonth = start.daysInMonth();
  const byDate = new Map(
    (rows || []).map((r) => [dayjs(r.attendanceDate).format('YYYY-MM-DD'), r.status])
  );

  let present = 0;
  let leave = 0;
  let lop = 0;
  let weekOff = 0;
  let holiday = 0;
  const paidLeave = new Set(['EL', 'PL', 'SL', 'CL']);

  for (let day = 1; day <= daysInMonth; day += 1) {
    const d = start.date(day);
    const key = d.format('YYYY-MM-DD');
    let status = byDate.get(key);

    if (joiningDate && d.isBefore(dayjs(joiningDate), 'day')) {
      status = 'L';
    }
    if (!status) {
      // Unmarked working day → LOP
      status = 'L';
    }

    if (status === 'P') present += 1;
    else if (paidLeave.has(status)) leave += 1;
    else if (status === 'W') weekOff += 1;
    else if (status === 'H') holiday += 1;
    else if (status === 'L' || status === 'A') lop += 1;
    else lop += 1;
  }

  const payableDays = present + leave + weekOff + holiday;
  return { present, leave, lop, weekOff, holiday, payableDays, daysInMonth };
}

export function countLeaveByType(rows) {
  const counts = { PL: 0, SL: 0, EL: 0, CL: 0 };
  for (const r of rows || []) {
    if (counts[r.status] !== undefined) counts[r.status] += 1;
  }
  return counts;
}
