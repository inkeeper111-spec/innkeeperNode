import mongoose from 'mongoose';

const amountItemSchema = new mongoose.Schema({
  type: { type: String, required: true, trim: true },
  amount: { type: Number, required: true, min: 0, default: 0 }
}, { _id: false });

const bankSchema = new mongoose.Schema({
  accountName: { type: String, default: '' },
  accountNo: { type: String, default: '' },
  IFSC: { type: String, default: '' }
}, { _id: false });

const staffSalarySchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    index: true
  },
  staffId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StaffProfile',
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  wages: { type: String, enum: ['M', 'D'], default: 'M' },
  salary: { type: Number, required: true, min: 0 },
  basic: { type: Number, default: 0, min: 0 },
  allowances: { type: Number, default: 0, min: 0 },
  earnings: { type: [amountItemSchema], default: [] },
  deductions: { type: [amountItemSchema], default: [] },
  bank: { type: bankSchema, default: () => ({}) },
  pfEligible: { type: String, enum: ['Y', 'N'], default: 'N' },
  pfNo: { type: String, default: '' },
  esiEligible: { type: String, enum: ['Y', 'N'], default: 'N' },
  esiNo: { type: String, default: '' },
  UANNo: { type: String, default: '' },
  weekOff: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WeekoffCategory',
    default: null
  },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

staffSalarySchema.index({ hotelId: 1, staffId: 1 }, { unique: true });

export const StaffSalary =
  mongoose.models.StaffSalary ||
  mongoose.model('StaffSalary', staffSalarySchema);
