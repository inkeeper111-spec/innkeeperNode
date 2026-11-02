import { randomBytes, randomInt } from 'node:crypto';

const getHotelTimestamp = (date, timeZone = 'UTC') => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}${values.month}${values.day}-${values.hour}${values.minute}${values.second}`;
};

const getHotelLetterPool = (hotelName) => {
  const letters = String(hotelName || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  return letters || 'HTL';
};

export const generateHotelReservationReference = (hotelName, timeZone = 'UTC', date = new Date()) => {
  const letterPool = getHotelLetterPool(hotelName);
  const prefixLength = randomInt(3, 5);
  const prefix = Array.from(
    { length: prefixLength },
    () => letterPool[randomInt(letterPool.length)]
  ).join('');
  const timestamp = getHotelTimestamp(date, timeZone);
  const uniqueSuffix = randomBytes(4).toString('hex').toUpperCase();
  return `${prefix}-${timestamp}-${uniqueSuffix}`;
};

const isBookingReferenceDuplicate = (error) => error?.code === 11000
  && (error.keyPattern?.bookingReference || error.message?.includes('bookingReference'));

export const createReservationWithUniqueReference = async (ReservationModel, reservationData, hotel) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const bookingReference = generateHotelReservationReference(hotel.name, hotel.timezone);
    if (await ReservationModel.exists({ bookingReference })) continue;

    try {
      return await ReservationModel.create({ ...reservationData, bookingReference });
    } catch (error) {
      if (!isBookingReferenceDuplicate(error)) throw error;
    }
  }

  throw new Error('Could not generate a unique reservation reference after several attempts.');
};
