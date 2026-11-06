import mongoose from 'mongoose';

const goodsReceiptLineSchema = new mongoose.Schema({
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
  receivedQuantity: { type: Number, required: true, min: 0 },
  acceptedQuantity: { type: Number, required: true, min: 0 },
  damagedQuantity: { type: Number, required: true, min: 0, default: 0 },
  rejectedQuantity: { type: Number, required: true, min: 0, default: 0 },
  unit: { type: String, trim: true, default: '' },
  unitId: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', default: null },
  conversionFactor: { type: Number, min: 0, default: 1 },
  baseUnit: { type: String, trim: true, default: '' },
  baseUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', default: null },
  batchNumber: { type: String, trim: true, default: '' },
  expiryDate: { type: Date, default: null },
  unitCost: { type: Number, required: true, min: 0 }
}, { _id: false });

const goodsReceiptSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true, index: true },
  purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder', required: true, index: true },
  receiptNumber: { type: String, required: true },
  requestKey: { type: String, default: undefined },
  invoiceNumber: { type: String, trim: true, default: '' },
  invoiceAttachment: { type: String, default: '' },
  location: { type: String, trim: true, default: 'Main Store' },
  lines: { type: [goodsReceiptLineSchema], required: true },
  receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receivedAt: { type: Date, default: Date.now },
  notes: { type: String, trim: true, default: '' }
}, { timestamps: true });

goodsReceiptSchema.index({ hotelId: 1, propertyId: 1, receiptNumber: 1 }, { unique: true });
goodsReceiptSchema.index(
  { hotelId: 1, propertyId: 1, requestKey: 1 },
  { unique: true, partialFilterExpression: { requestKey: { $type: 'string' } } }
);

export const GoodsReceipt = mongoose.models.GoodsReceipt || mongoose.model('GoodsReceipt', goodsReceiptSchema);
