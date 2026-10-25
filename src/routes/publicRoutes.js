import { Router } from 'express';
import {
  listPublicHotels,
  getPublicHotel,
  searchPublicRooms,
  bookPublicReservation,
  lookupPublicReservation
} from '../controllers/publicController.js';

const router = Router();

router.get('/hotels', listPublicHotels);
router.get('/hotel', getPublicHotel);
router.get('/hotel/:slug', getPublicHotel);
router.get('/rooms/search', searchPublicRooms);
router.post('/bookings', bookPublicReservation);
router.get('/bookings/lookup', lookupPublicReservation);

export default router;

