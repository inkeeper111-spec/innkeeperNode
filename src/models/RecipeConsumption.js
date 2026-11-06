import mongoose from 'mongoose';

const consumedIngredientSchema = new mongoose.Schema({
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
  menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: true },
  menuItemName: { type: String, required: true },
  recipeVersion: { type: Number, required: true },
  quantity: { type: Number, required: true, min: 0 },
  unit: { type: String, required: true },
  enteredQuantity: { type: Number, min: 0, default: null },
  enteredUnit: { type: String, trim: true, default: '' },
  conversionFactor: { type: Number, min: 0, default: 1 },
  baseUnit: { type: String, trim: true, default: '' },
  unitCost: { type: Number, required: true, min: 0 },
  totalCost: { type: Number, required: true, min: 0 }
}, { _id: false });

const recipeConsumptionSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true, index: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodOrder', required: true },
  orderNumber: { type: String, required: true },
  ingredients: { type: [consumedIngredientSchema], default: [] },
  totalCost: { type: Number, min: 0, default: 0 },
  status: { type: String, enum: ['deducted', 'reversed'], default: 'deducted' },
  deductedAt: { type: Date, default: Date.now },
  reversedAt: { type: Date, default: null }
}, { timestamps: true });

recipeConsumptionSchema.index({ hotelId: 1, propertyId: 1, orderId: 1 }, { unique: true });

export const RecipeConsumption = mongoose.models.RecipeConsumption
  || mongoose.model('RecipeConsumption', recipeConsumptionSchema);
