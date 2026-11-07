import mongoose from 'mongoose';

const rawMaterialSubcategorySchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'RawMaterialCategory', required: true, index: true },
  name: { type: String, required: true, trim: true },
  nameKey: { type: String, required: true, trim: true, lowercase: true },
  description: { type: String, trim: true, default: '' },
  isActive: { type: Boolean, default: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

rawMaterialSubcategorySchema.pre('validate', function normalizeName() {
  if (this.name) this.nameKey = this.name.trim().toLocaleLowerCase();
});

rawMaterialSubcategorySchema.index({ hotelId: 1, categoryId: 1, nameKey: 1 }, { unique: true });
rawMaterialSubcategorySchema.index({ hotelId: 1, categoryId: 1, isActive: 1, name: 1 });

export const RawMaterialSubcategory = mongoose.models.RawMaterialSubcategory
  || mongoose.model('RawMaterialSubcategory', rawMaterialSubcategorySchema);
