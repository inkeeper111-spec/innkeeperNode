import { Router } from 'express';
import {
  getHotelProfile,
  updateHotelProfile,
  getProperties,
  createProperty,
  updateProperty
} from '../controllers/hotelController.js';
import { authenticate, requireTenant, authorize } from '../middlewares/auth.js';
import { ROLES } from '../config/constants.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

router.get('/', getHotelProfile);
router.put('/', authorize(ROLES.HOTEL_ADMIN), updateHotelProfile);

router.get('/properties', getProperties);
router.post('/properties', authorize(ROLES.HOTEL_ADMIN), createProperty);
router.put('/properties/:id', authorize(ROLES.HOTEL_ADMIN), updateProperty);

export default router;

