import { Router } from 'express';
import {
  listPublicHotels,
  getPublicHotel,
  searchPublicRooms,
  bookPublicReservation,
  lookupPublicReservation
} from '../controllers/publicController.js';
import { validatePhoneFields } from '../middlewares/phoneValidator.js';

const router = Router();

router.get('/hotels', listPublicHotels);
router.get('/hotel', getPublicHotel);
router.get('/hotel/:slug', getPublicHotel);
router.get('/rooms/search', searchPublicRooms);
router.post('/bookings', validatePhoneFields({ path: 'guestPhone', required: true }), bookPublicReservation);
router.get('/bookings/lookup', lookupPublicReservation);

export default router;
