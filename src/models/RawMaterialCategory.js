import mongoose from 'mongoose';

const rawMaterialCategorySchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  name: { type: String, required: true, trim: true },
  nameKey: { type: String, required: true, trim: true, lowercase: true },
  categoryCode: { type: String, required: true, trim: true, uppercase: true },
  description: { type: String, trim: true, default: '' },
  isActive: { type: Boolean, default: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

rawMaterialCategorySchema.pre('validate', function normalizeName() {
  if (this.name) this.nameKey = this.name.trim().toLocaleLowerCase();
});

rawMaterialCategorySchema.index({ hotelId: 1, nameKey: 1 }, { unique: true });
rawMaterialCategorySchema.index({ hotelId: 1, categoryCode: 1 }, { unique: true });
rawMaterialCategorySchema.index({ hotelId: 1, isActive: 1, name: 1 });

export const RawMaterialCategory = mongoose.models.RawMaterialCategory
  || mongoose.model('RawMaterialCategory', rawMaterialCategorySchema);
