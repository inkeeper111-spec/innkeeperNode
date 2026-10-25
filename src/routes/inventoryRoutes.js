import { Router } from 'express';
import {
  getInventoryItems,
  createInventoryItem,
  recordStockMovement,
  getVendors,
  createVendor,
  getPurchaseOrders,
  createPurchaseOrder,
  receivePurchaseOrder
} from '../controllers/inventoryController.js';
import { authenticate, requireTenant } from '../middlewares/auth.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

router.get('/items', getInventoryItems);
router.post('/items', createInventoryItem);
router.post('/movements', recordStockMovement);

router.get('/vendors', getVendors);
router.post('/vendors', createVendor);

router.get('/purchase-orders', getPurchaseOrders);
router.post('/purchase-orders', createPurchaseOrder);
router.patch('/purchase-orders/:id/receive', receivePurchaseOrder);

export default router;

