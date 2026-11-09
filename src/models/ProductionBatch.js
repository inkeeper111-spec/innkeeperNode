import mongoose from 'mongoose';

const ingredientLineSchema = new mongoose.Schema({
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
  itemName: { type: String, required: true },
  theoreticalQuantity: { type: Number, min: 0, default: 0 },
  actualQuantity: { type: Number, min: 0, required: true },
  wastageQuantity: { type: Number, min: 0, default: 0 },
  unit: { type: String, required: true },
  conversionFactor: { type: Number, min: 0, default: 1 },
  unitCost: { type: Number, min: 0, default: 0 },
  totalCost: { type: Number, min: 0, default: 0 },
  wastageCost: { type: Number, min: 0, default: 0 },
  movementId: { type: mongoose.Schema.Types.ObjectId, ref: 'StockMovement', default: null },
  wastageMovementId: { type: mongoose.Schema.Types.ObjectId, ref: 'StockMovement', default: null },
  wastageReason: { type: String, trim: true, default: '' }
}, { _id: false });

const productionBatchSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true, index: true },
  batchNumber: { type: String, required: true },
  idempotencyKey: { type: String, default: undefined },
  menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: true, index: true },
  menuItemName: { type: String, required: true },
  recipeId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryRecipe', required: true },
  recipeVersion: { type: Number, required: true },
  recipeName: { type: String, default: '' },
  servingSize: { type: String, default: '1 serving' },
  productionMethod: { type: String, enum: ['recipe_based', 'actual_consumption'], required: true },
  productionQuantity: { type: Number, required: true, min: 0.00000001 },
  acceptedQuantity: { type: Number, required: true, min: 0 },
  availableQuantity: { type: Number, required: true, min: 0 },
  reservedQuantity: { type: Number, min: 0, default: 0 },
  soldQuantity: { type: Number, min: 0, default: 0 },
  wastedQuantity: { type: Number, min: 0, default: 0 },
  complimentaryQuantity: { type: Number, min: 0, default: 0 },
  staffConsumptionQuantity: { type: Number, min: 0, default: 0 },
  transferredOutQuantity: { type: Number, min: 0, default: 0 },
  isTransferBatch: { type: Boolean, default: false },
  transferredFromBatchId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionBatch', default: null },
  ingredients: { type: [ingredientLineSchema], required: true },
  productionCost: { type: Number, min: 0, required: true },
  rawMaterialWastageCost: { type: Number, min: 0, default: 0 },
  costPerPortion: { type: Number, min: 0, default: 0 },
  sellingPrice: { type: Number, min: 0, default: 0 },
  location: { type: String, trim: true, required: true },
  productionDate: { type: Date, required: true, default: Date.now },
  receivedAt: { type: Date, required: true, default: Date.now },
  expiryDate: { type: Date, default: null },
  preparedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  status: { type: String, enum: ['active', 'cancelled'], default: 'active', index: true },
  notes: { type: String, trim: true, default: '' }
}, { timestamps: true });

productionBatchSchema.index({ hotelId: 1, propertyId: 1, batchNumber: 1 }, { unique: true });
productionBatchSchema.index(
  { hotelId: 1, propertyId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

export const ProductionBatch = mongoose.models.ProductionBatch
  || mongoose.model('ProductionBatch', productionBatchSchema);
