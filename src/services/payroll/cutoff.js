import dayjs from 'dayjs';
import { GlobalConfiguration } from '../../models/GlobalConfiguration.js';

/**
 * For period YYYY-MM, edit/run window = next calendar month, days 1 .. cutOffDay
 * @returns {{ status: 'before_window'|'in_window'|'after_window'|'config_missing', config: object|null, windowStart: string|null, windowEnd: string|null, message: string }}
 */
export function evaluateCutoffWindow(config, monthYear, cutoffField, now = dayjs()) {
  if (!config || !config[cutoffField]) {
    return {
      status: 'config_missing',
      config: config || null,
      windowStart: null,
      windowEnd: null,
      message: 'Global Configuration with cut-off days is required. Configure attendance and payroll cut-off days first.'
    };
  }

  const period = dayjs(`${monthYear}-01`);
  if (!period.isValid()) {
    return {
      status: 'config_missing',
      config,
      windowStart: null,
      windowEnd: null,
      message: 'Invalid monthYear. Use YYYY-MM.'
    };
  }

  const nextMonth = period.add(1, 'month');
  const cutOffDay = Number(config[cutoffField]);
  const daysInNext = nextMonth.daysInMonth();
  const effectiveDay = Math.min(cutOffDay, daysInNext);
  const windowStart = nextMonth.date(1).startOf('day');
  const windowEnd = nextMonth.date(effectiveDay).endOf('day');

  let status = 'in_window';
  if (now.isBefore(windowStart)) status = 'before_window';
  else if (now.isAfter(windowEnd)) status = 'after_window';

  const messages = {
    before_window: `Cut-off window opens on ${windowStart.format('YYYY-MM-DD')} (day 1 of next month).`,
    in_window: `Within cut-off window until ${windowEnd.format('YYYY-MM-DD')}.`,
    after_window: `Cut-off window closed after ${windowEnd.format('YYYY-MM-DD')}.`
  };

  return {
    status,
    config,
    windowStart: windowStart.format('YYYY-MM-DD'),
    windowEnd: windowEnd.format('YYYY-MM-DD'),
    message: messages[status]
  };
}

export async function getCutoffStatus(hotelId, monthYear, type = 'attendance') {
  const config = await GlobalConfiguration.findOne({ hotelId }).lean();
  const field = type === 'payroll' ? 'payrollCutoffDay' : 'attendanceCutoffDay';
  return evaluateCutoffWindow(config, monthYear, field);
}

export function assertInWindow(cutoffResult) {
  if (cutoffResult.status === 'config_missing') {
    const err = new Error(cutoffResult.message);
    err.statusCode = 400;
    err.code = 'CONFIG_MISSING';
    throw err;
  }
  if (cutoffResult.status !== 'in_window') {
    const err = new Error(cutoffResult.message);
    err.statusCode = 403;
    err.code = 'OUTSIDE_CUTOFF_WINDOW';
    throw err;
  }
}
