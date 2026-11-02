const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isValidDateOnly = (value) => {
  if (typeof value !== 'string' || !DATE_ONLY_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

export const getHotelLocalDate = (timeZone = 'UTC', now = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const dateParts = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
};

export const dateOnlyFromStoredDate = (date) => {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
};

export const isValidHotelTime = (time) => typeof time === 'string'
  && /^([01]\d|2[0-3]):[0-5]\d$/.test(time);

export const combineHotelDateAndTime = (dateOnly, time, timeZone = 'UTC') => {
  if (!isValidDateOnly(dateOnly) || !isValidHotelTime(time)) return null;
  const [year, month, day] = dateOnly.split('-').map(Number);
  const [hours, minutes] = time.split(':').map(Number);
  const targetUtc = Date.UTC(year, month - 1, day, hours, minutes);
  let timestamp = targetUtc;

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    const representedUtc = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute)
    );
    timestamp += targetUtc - representedUtc;
  }

  const result = new Date(timestamp);
  const check = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(result);
  const values = Object.fromEntries(check.map(({ type, value }) => [type, value]));
  if (
    Number(values.year) !== year
    || Number(values.month) !== month
    || Number(values.day) !== day
    || Number(values.hour) !== hours
    || Number(values.minute) !== minutes
  ) return null;
  return result;
};

export const validateReservationDateRange = (checkInDate, checkOutDate, timeZone = 'UTC', now = new Date()) => {
  if (!isValidDateOnly(checkInDate) || !isValidDateOnly(checkOutDate)) {
    return { error: 'Please select a valid reservation date.' };
  }

  const today = getHotelLocalDate(timeZone, now);
  if (checkInDate < today || checkOutDate < today) {
    return { error: 'Past dates are not allowed.' };
  }

  if (checkOutDate <= checkInDate) {
    return { error: 'Check-out date must be later than check-in date.' };
  }

  const start = new Date(`${checkInDate}T00:00:00.000Z`);
  const end = new Date(`${checkOutDate}T00:00:00.000Z`);
  const nights = (end.getTime() - start.getTime()) / 86_400_000;
  return { start, end, nights };
};
