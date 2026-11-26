import { Router } from 'express';
import {
  getInventoryItems,
  getInventoryBatches,
  createInventoryItem,
  updateInventoryItem,
  recordStockMovement,
  correctPurchaseMovement,
  cancelPurchaseMovement,
  getVendors,
  createVendor,
  updateVendor,
  getVendorPurchases,
  getVendorPayments,
  recordVendorPayment,
  getPurchaseOrders,
  createPurchaseOrder,
  reviewAutomaticReorder,
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
  deleteRawMaterial,
  getRawMaterialCategories,
  getRawMaterials,
  getRawMaterialSubcategories,
  updateRawMaterial,
  updateRawMaterialCategory,
  updateRawMaterialSubcategory
} from '../controllers/rawMaterialController.js';
import {
  downloadRawMaterialBulkFailedFile,
  downloadRawMaterialBulkTemplate,
  getRawMaterialBulkUploadLog,
  getRawMaterialBulkUploadLogs,
  uploadRawMaterialsBulk
} from '../controllers/rawMaterialBulkUploadController.js';
import {
  approvePurchaseOrder,
  assignMinibarStock,
  cancelStockTransfer,
  createDepartmentRequest,
  createDirectInventoryUsage,
  createStockAdjustment,
  exportInventoryReport,
  getDepartmentRequests,
  getDirectInventoryUsage,
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
  getRecipeIngredientBatchDetails,
  updateInventorySettings,
  reviewDepartmentRequest,
  saveRecipe,
  setRecipeStatus,
  reconcileMinibar,
  transferStockBetweenLocations
} from '../controllers/inventoryAdvancedController.js';
import {
  cancelProductionEntry,
  createProductionEntry,
  getProductionDashboard,
  recordPreparedFoodMovement,
  transferProductionBatch
} from '../controllers/productionController.js';
import {
  createStorageLocation,
  getStorageLocationStockReport,
  getStorageLocationTypes,
  getStorageLocations,
  updateStorageLocation
} from '../controllers/storageLocationController.js';
import {
  approvePurchaseInvoice,
  approveSupplierReturn,
  cancelProcurementOrder,
  completeSupplierReturn,
  createInvoicePayment,
  createOrderFromRequisition,
  createPurchaseInvoice,
  createPurchaseRequisition,
  createSupplierReturn,
  exportProcurementReport,
  getProcurementDashboard,
  inspectGoodsReceipt,
  listPurchaseInvoices,
  listPurchaseRequisitions,
  listSupplierReturns,
  reviewProcurementOrder,
  reviewPurchaseRequisition,
  verifyPurchaseInvoice
} from '../controllers/procurementController.js';
import { SupplierPayment } from '../models/SupplierPayment.js';
import { authenticate, requireTenant, authorize } from '../middlewares/auth.js';
import { uploadRawMaterialBulk } from '../middlewares/upload.js';
import { validatePhoneFields } from '../middlewares/phoneValidator.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

router.get('/items', getInventoryItems);
router.get('/batches', getInventoryBatches);
router.get('/raw-materials/categories', getRawMaterialCategories);
router.post('/raw-materials/categories', authorize(), createRawMaterialCategory);
router.patch('/raw-materials/categories/:id', authorize(), updateRawMaterialCategory);
router.get('/raw-materials/subcategories', getRawMaterialSubcategories);
router.post('/raw-materials/subcategories', authorize(), createRawMaterialSubcategory);
router.patch('/raw-materials/subcategories/:id', authorize(), updateRawMaterialSubcategory);
router.get('/raw-materials', getRawMaterials);
router.get('/raw-materials/bulk-upload/template', downloadRawMaterialBulkTemplate);
router.get('/raw-materials/bulk-upload/logs', getRawMaterialBulkUploadLogs);
router.get('/raw-materials/bulk-upload/logs/:id', getRawMaterialBulkUploadLog);
router.get('/raw-materials/bulk-upload/logs/:id/failed-file', downloadRawMaterialBulkFailedFile);
router.post('/raw-materials/bulk-upload', authorize(), (req, res, next) => {
  uploadRawMaterialBulk.single('file')(req, res, (error) => {
    if (!error) return uploadRawMaterialsBulk(req, res, next);
    error.statusCode = 400;
    if (error.code === 'LIMIT_FILE_SIZE') error.message = 'File size exceeds the 10MB limit.';
    return next(error);
  });
});
router.post('/raw-materials', authorize(), createRawMaterial);
router.patch('/raw-materials/:id', authorize(), updateRawMaterial);
router.delete('/raw-materials/:id', authorize(), deleteRawMaterial);
router.get('/units', getInventoryUnits);
router.post('/units', authorize(), createInventoryUnit);
router.post('/units/defaults', authorize(), createDefaultInventoryUnits);
router.patch('/units/:id', authorize(), updateInventoryUnit);
router.delete('/units/:id', authorize(), deleteInventoryUnit);
router.post('/items', authorize(), createInventoryItem);
router.patch('/items/:id', authorize(), updateInventoryItem);
router.post('/movements', recordStockMovement);
router.patch('/movements/:id', authorize(), correctPurchaseMovement);
router.post('/movements/:id/cancel', authorize(), cancelPurchaseMovement);
router.get('/usage', getDirectInventoryUsage);
router.post('/usage', createDirectInventoryUsage);
router.get('/dashboard', getInventoryDashboard);
router.get('/settings', getInventorySettings);
router.patch('/settings', authorize(), updateInventorySettings);
router.get('/verifications', getStockVerifications);
router.post('/verifications', createStockVerification);
router.get('/locations', getStockLocations);
router.get('/storage-location-types', getStorageLocationTypes);
router.get('/storage-locations', getStorageLocations);
router.get('/storage-locations/:id/stock', getStorageLocationStockReport);
router.post('/storage-locations', authorize(), createStorageLocation);
router.patch('/storage-locations/:id', authorize(), updateStorageLocation);
router.post('/transfers', authorize(), transferStockBetweenLocations);
router.post('/transfers/:id/cancel', authorize(), cancelStockTransfer);
router.get('/ledger', getStockLedger);
router.get('/adjustments', getStockAdjustments);
router.post('/adjustments', createStockAdjustment);
router.get('/reorder-suggestions', getReorderSuggestions);
router.get('/reports/export', exportInventoryReport);
router.get('/reports', getInventoryReport);

router.get('/vendors', getVendors);
router.post('/vendors', authorize(), validatePhoneFields({ path: 'phone', required: true }), createVendor);
router.patch('/vendors/:id', authorize(), updateVendor);
router.get('/vendors/:id/purchases', authorize(), getVendorPurchases);
router.get('/vendors/:id/payments', authorize(), getVendorPayments);
router.post('/vendors/:id/payments', authorize(), recordVendorPayment);

router.get('/purchase-orders', getPurchaseOrders);
router.post('/purchase-orders', authorize(), createPurchaseOrder);
router.patch('/purchase-orders/:id/review', authorize(), reviewAutomaticReorder);
router.patch('/purchase-orders/:id/approve', approvePurchaseOrder);
router.patch('/purchase-orders/:id/receive', authorize(), receivePurchaseOrderGoods);
router.get('/goods-receipts', getGoodsReceipts);

router.get('/procurement/dashboard', authorize(), getProcurementDashboard);
router.get('/procurement/requisitions', authorize(), listPurchaseRequisitions);
router.post('/procurement/requisitions', authorize(), createPurchaseRequisition);
router.patch('/procurement/requisitions/:id/review', authorize(), reviewPurchaseRequisition);
router.get('/procurement/orders', authorize(), getPurchaseOrders);
router.post('/procurement/orders/from-requisition/:id', authorize(), createOrderFromRequisition);
router.patch('/procurement/orders/:id/review', authorize(), reviewProcurementOrder);
router.patch('/procurement/orders/:id/cancel', authorize(), cancelProcurementOrder);
router.get('/procurement/receipts', authorize(), getGoodsReceipts);
router.patch('/procurement/receipts/:id/inspect', authorize(), inspectGoodsReceipt);
router.get('/procurement/suppliers', authorize(), getVendors);
router.post('/procurement/suppliers', authorize(), validatePhoneFields({ path: 'phone', required: true }), createVendor);
router.patch('/procurement/suppliers/:id', authorize(), updateVendor);
router.get('/procurement/invoices', authorize(), listPurchaseInvoices);
router.post('/procurement/invoices', authorize(), createPurchaseInvoice);
router.patch('/procurement/invoices/:id/verify', authorize(), verifyPurchaseInvoice);
router.patch('/procurement/invoices/:id/approve', authorize(), approvePurchaseInvoice);
router.get('/procurement/payments', authorize(), async (req, res, next) => {
  try {
    const data = await SupplierPayment.find({
      hotelId: req.hotelId, propertyId: req.propertyId
    }).populate('vendorId', 'name supplierCode').populate('recordedBy', 'name')
      .populate('allocations.invoiceId', 'supplierInvoiceNumber').sort({ paidAt: -1 }).limit(500).lean();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});
router.post('/procurement/payments', authorize(), createInvoicePayment);
router.get('/procurement/returns', authorize(), listSupplierReturns);
router.post('/procurement/returns', authorize(), createSupplierReturn);
router.patch('/procurement/returns/:id/approve', authorize(), approveSupplierReturn);
router.patch('/procurement/returns/:id/complete', authorize(), completeSupplierReturn);
router.get('/procurement/reports', authorize(), exportProcurementReport);

router.get('/department-requests', getDepartmentRequests);
router.post('/department-requests', createDepartmentRequest);
router.patch('/department-requests/:id/review', reviewDepartmentRequest);

router.get('/recipes', getRecipes);
router.get('/recipes/:id/ingredient-batches', getRecipeIngredientBatchDetails);
router.post('/recipes', authorize(), saveRecipe);
router.patch('/recipes/:id/status', authorize(), setRecipeStatus);
router.get('/production', getProductionDashboard);
router.post('/production', authorize(), createProductionEntry);
router.post('/production/:id/transfer', authorize(), transferProductionBatch);
router.post('/production/:id/cancel', authorize(), cancelProductionEntry);
router.post('/production/:id/movements', authorize(), recordPreparedFoodMovement);
router.get('/minibar/rooms', getMinibarRooms);
router.get('/minibar/rooms/:roomId', getMinibarRoomStock);
router.post('/minibar/rooms/:roomId/stock', assignMinibarStock);
router.post('/minibar/rooms/:roomId/reconcile', reconcileMinibar);

export default router;
