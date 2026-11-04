import { Router } from 'express';
import {
  getInventoryItems,
  createInventoryItem,
  updateInventoryItem,
  recordStockMovement,
  getVendors,
  createVendor,
  updateVendor,
  getVendorPurchases,
  getVendorPayments,
  recordVendorPayment,
  getPurchaseOrders,
  createPurchaseOrder,
  receivePurchaseOrderGoods
} from '../controllers/inventoryController.js';
import {
  approvePurchaseOrder,
  assignMinibarStock,
  createDepartmentRequest,
  createStockAdjustment,
  exportInventoryReport,
  getDepartmentRequests,
  getGoodsReceipts,
  getInventoryDashboard,
  getInventoryReport,
  getMinibarRooms,
  getMinibarRoomStock,
  getRecipes,
  getReorderSuggestions,
  getStockLedger,
  getStockLocations,
  getStockAdjustments,
  reviewDepartmentRequest,
  saveRecipe,
  reviewStockAdjustment,
  reconcileMinibar,
  transferStockBetweenLocations
} from '../controllers/inventoryAdvancedController.js';
import { authenticate, requireTenant, authorize } from '../middlewares/auth.js';
import { ROLES } from '../config/constants.js';
import { validatePhoneFields } from '../middlewares/phoneValidator.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

router.get('/items', getInventoryItems);
router.post('/items', authorize(ROLES.HOTEL_ADMIN), createInventoryItem);
router.patch('/items/:id', authorize(ROLES.HOTEL_ADMIN), updateInventoryItem);
router.post('/movements', recordStockMovement);
router.get('/dashboard', getInventoryDashboard);
router.get('/locations', getStockLocations);
router.post('/transfers', authorize(ROLES.HOTEL_ADMIN), transferStockBetweenLocations);
router.get('/ledger', getStockLedger);
router.get('/adjustments', getStockAdjustments);
router.post('/adjustments', createStockAdjustment);
router.patch('/adjustments/:id/review', reviewStockAdjustment);
router.get('/reorder-suggestions', getReorderSuggestions);
router.get('/reports/export', exportInventoryReport);
router.get('/reports', getInventoryReport);

router.get('/vendors', getVendors);
router.post('/vendors', authorize(ROLES.HOTEL_ADMIN), validatePhoneFields({ path: 'phone', required: true }), createVendor);
router.patch('/vendors/:id', authorize(ROLES.HOTEL_ADMIN), updateVendor);
router.get('/vendors/:id/purchases', authorize(ROLES.HOTEL_ADMIN), getVendorPurchases);
router.get('/vendors/:id/payments', authorize(ROLES.HOTEL_ADMIN), getVendorPayments);
router.post('/vendors/:id/payments', authorize(ROLES.HOTEL_ADMIN), recordVendorPayment);

router.get('/purchase-orders', getPurchaseOrders);
router.post('/purchase-orders', authorize(ROLES.HOTEL_ADMIN), createPurchaseOrder);
router.patch('/purchase-orders/:id/approve', approvePurchaseOrder);
router.patch('/purchase-orders/:id/receive', authorize(ROLES.HOTEL_ADMIN), receivePurchaseOrderGoods);
router.get('/goods-receipts', getGoodsReceipts);

router.get('/department-requests', getDepartmentRequests);
router.post('/department-requests', createDepartmentRequest);
router.patch('/department-requests/:id/review', reviewDepartmentRequest);

router.get('/recipes', getRecipes);
router.post('/recipes', authorize(ROLES.HOTEL_ADMIN), saveRecipe);
router.get('/minibar/rooms', getMinibarRooms);
router.get('/minibar/rooms/:roomId', getMinibarRoomStock);
router.post('/minibar/rooms/:roomId/stock', assignMinibarStock);
router.post('/minibar/rooms/:roomId/reconcile', reconcileMinibar);

export default router;
