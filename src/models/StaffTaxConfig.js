import mongoose from 'mongoose';

const namedToggleSchema = new mongoose.Schema({
  type: { type: String, required: true, trim: true },
  isActive: { type: Boolean, default: true }
}, { _id: false });

const professionTaxSlabSchema = new mongoose.Schema({
  minSalary: { type: Number, required: true, min: 0 },
  maxSalary: { type: Number, required: true, min: 0 },
  taxAmount: { type: Number, required: true, min: 0 }
}, { _id: false });

const staffTaxConfigSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    unique: true,
    index: true
  },
  basicPercent: { type: Number, default: 0, min: 0, max: 100 },
  earnings: { type: [namedToggleSchema], default: [] },
  deductions: { type: [namedToggleSchema], default: [] },
  pfPercent: { type: Number, default: 12, min: 0 },
  pfActive: { type: Boolean, default: true },
  esiPercent: { type: Number, default: 0.75, min: 0 },
  esiActive: { type: Boolean, default: true },
  professionTax: {
    mode: { type: String, enum: ['FIXED', 'SLAB'], default: 'FIXED' },
    fixedAmount: { type: Number, default: 0, min: 0 },
    slabs: { type: [professionTaxSlabSchema], default: [] }
  }
}, { timestamps: true });

export const StaffTaxConfig =
  mongoose.models.StaffTaxConfig ||
  mongoose.model('StaffTaxConfig', staffTaxConfigSchema);
