import { Router } from 'express';
import {
  getInventoryItems,
  getInventoryBatches,
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
  createDefaultInventoryUnits,
  createInventoryUnit,
  deleteInventoryUnit,
  getInventoryUnits,
  updateInventoryUnit
} from '../controllers/inventoryUnitController.js';
import {
  createRawMaterial,
  createRawMaterialCategory,
  createRawMaterialSubcategory,
  getRawMaterialCategories,
  getRawMaterials,
  getRawMaterialSubcategories,
  updateRawMaterial,
  updateRawMaterialCategory,
  updateRawMaterialSubcategory
} from '../controllers/rawMaterialController.js';
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
  createStockVerification,
  getStockVerifications,
  getInventorySettings,
  updateInventorySettings,
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
router.get('/batches', getInventoryBatches);
router.get('/raw-materials/categories', authorize(ROLES.HOTEL_ADMIN), getRawMaterialCategories);
router.post('/raw-materials/categories', authorize(ROLES.HOTEL_ADMIN), createRawMaterialCategory);
router.patch('/raw-materials/categories/:id', authorize(ROLES.HOTEL_ADMIN), updateRawMaterialCategory);
router.get('/raw-materials/subcategories', authorize(ROLES.HOTEL_ADMIN), getRawMaterialSubcategories);
router.post('/raw-materials/subcategories', authorize(ROLES.HOTEL_ADMIN), createRawMaterialSubcategory);
router.patch('/raw-materials/subcategories/:id', authorize(ROLES.HOTEL_ADMIN), updateRawMaterialSubcategory);
router.get('/raw-materials', getRawMaterials);
router.post('/raw-materials', authorize(ROLES.HOTEL_ADMIN), createRawMaterial);
router.patch('/raw-materials/:id', authorize(ROLES.HOTEL_ADMIN), updateRawMaterial);
router.get('/units', getInventoryUnits);
router.post('/units', authorize(ROLES.HOTEL_ADMIN), createInventoryUnit);
router.post('/units/defaults', authorize(ROLES.HOTEL_ADMIN), createDefaultInventoryUnits);
router.patch('/units/:id', authorize(ROLES.HOTEL_ADMIN), updateInventoryUnit);
router.delete('/units/:id', authorize(ROLES.HOTEL_ADMIN), deleteInventoryUnit);
router.post('/items', authorize(ROLES.HOTEL_ADMIN), createInventoryItem);
router.patch('/items/:id', authorize(ROLES.HOTEL_ADMIN), updateInventoryItem);
router.post('/movements', recordStockMovement);
router.get('/dashboard', getInventoryDashboard);
router.get('/settings', getInventorySettings);
router.patch('/settings', authorize(ROLES.HOTEL_ADMIN), updateInventorySettings);
router.get('/verifications', getStockVerifications);
router.post('/verifications', createStockVerification);
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
