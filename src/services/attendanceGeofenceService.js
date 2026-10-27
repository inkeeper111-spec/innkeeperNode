import { Hotel } from '../models/Hotel.js';

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

export const calculateDistanceMeters = (latitudeA, longitudeA, latitudeB, longitudeB) => {
  const radians = (degrees) => degrees * (Math.PI / 180);
  const earthRadiusMeters = 6371000;
  const latitudeDelta = radians(latitudeB - latitudeA);
  const longitudeDelta = radians(longitudeB - longitudeA);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(latitudeA))
    * Math.cos(radians(latitudeB))
    * Math.sin(longitudeDelta / 2) ** 2;
  const boundedHaversine = Math.min(1, Math.max(0, haversine));
  return earthRadiusMeters * 2 * Math.atan2(
    Math.sqrt(boundedHaversine),
    Math.sqrt(1 - boundedHaversine)
  );
};

export const validateAttendanceLocation = async ({ hotelId, latitude, longitude, accuracyMeters }) => {
  const hotel = await Hotel.findById(hotelId).select('attendanceLocation').lean();
  const location = hotel?.attendanceLocation;
  const radiusMeters = location?.radiusMeters ?? 50;
  const maxAccuracyMeters = location?.maxAccuracyMeters ?? 25;

  let failureReason = '';
  let distanceMeters = null;
  if (!location || !isFiniteNumber(location.latitude) || !isFiniteNumber(location.longitude)) {
    failureReason = 'The hotel attendance location has not been configured.';
  } else if (
    !isFiniteNumber(latitude)
    || latitude < -90
    || latitude > 90
    || !isFiniteNumber(longitude)
    || longitude < -180
    || longitude > 180
  ) {
    failureReason = 'A valid device location is required to mark attendance.';
  } else if (!isFiniteNumber(accuracyMeters) || accuracyMeters < 0) {
    failureReason = 'A valid GPS accuracy reading is required to mark attendance.';
  } else {
    distanceMeters = calculateDistanceMeters(
      latitude,
      longitude,
      location.latitude,
      location.longitude
    );
    if (accuracyMeters > maxAccuracyMeters) {
      failureReason = `GPS accuracy is too low. Improve the location accuracy to ${maxAccuracyMeters} meters or better and retry.`;
    } else if (distanceMeters > radiusMeters) {
      failureReason = `Attendance cannot be marked because you are outside the permitted ${radiusMeters}-meter radius of your assigned hotel.`;
    }
  }

  return {
    valid: !failureReason,
    failureReason,
    distanceMeters,
    radiusMeters,
    maxAccuracyMeters
  };
};
