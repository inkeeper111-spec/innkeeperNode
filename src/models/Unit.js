import mongoose from 'mongoose';

const unitSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  name: { type: String, required: true, trim: true },
  nameKey: { type: String, required: true, trim: true, lowercase: true },
  symbol: { type: String, required: true, trim: true },
  symbolKey: { type: String, required: true, trim: true, lowercase: true },
  category: {
    type: String,
    required: true,
    enum: ['weight', 'volume', 'quantity', 'package', 'length', 'area', 'other']
  },
  isStandard: { type: Boolean, default: false },
  baseUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', default: null, index: true },
  conversionFactor: { type: Number, min: 0.000000001, default: null },
  description: { type: String, trim: true, default: '' },
  isActive: { type: Boolean, default: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

unitSchema.pre('validate', function setNormalizedKeys() {
  if (this.name) this.nameKey = this.name.trim().toLocaleLowerCase();
  if (this.symbol) this.symbolKey = this.symbol.trim().toLocaleLowerCase();
});

unitSchema.index({ hotelId: 1, nameKey: 1 }, { unique: true });
unitSchema.index({ hotelId: 1, symbolKey: 1 }, { unique: true });
unitSchema.index({ hotelId: 1, category: 1, isActive: 1, name: 1 });

export const Unit = mongoose.models.Unit || mongoose.model('Unit', unitSchema);
