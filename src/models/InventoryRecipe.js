import mongoose from 'mongoose';

const ingredientSchema = new mongoose.Schema({
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
  quantity: { type: Number, required: true, min: 0.00000001 },
  unit: { type: String, required: true, trim: true },
  conversionFactor: { type: Number, min: 0, default: null },
  baseUnit: { type: String, trim: true, default: '' },
  optional: { type: Boolean, default: false },
  substitutions: [{
    itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem' },
    quantity: { type: Number, min: 0.00000001 },
    unit: { type: String, trim: true },
    conversionFactor: { type: Number, min: 0, default: null },
    baseUnit: { type: String, trim: true, default: '' }
  }]
}, { _id: false });

const inventoryRecipeSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true, index: true },
  menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: true, index: true },
  recipeName: { type: String, trim: true, default: '' },
  description: { type: String, trim: true, default: '' },
  servingSize: { type: String, trim: true, default: '1 serving' },
  preparationTimeMinutes: { type: Number, min: 0, default: 0 },
  version: { type: Number, required: true, min: 1 },
  ingredients: { type: [ingredientSchema], required: true, validate: [(items) => items.length > 0, 'Recipe requires at least one ingredient.'] },
  isActive: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

inventoryRecipeSchema.index({ hotelId: 1, propertyId: 1, menuItemId: 1, version: 1 }, { unique: true });

export const InventoryRecipe = mongoose.models.InventoryRecipe
  || mongoose.model('InventoryRecipe', inventoryRecipeSchema);
