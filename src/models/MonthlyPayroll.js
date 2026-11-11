import mongoose from 'mongoose';

const amountItemSchema = new mongoose.Schema({
  type: { type: String, required: true },
  amount: { type: Number, required: true, min: 0 }
}, { _id: false });

const monthlyPayrollSchema = new mongoose.Schema({
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
  monthYear: { type: String, required: true, index: true },
  present: { type: Number, default: 0 },
  leave: { type: Number, default: 0 },
  lop: { type: Number, default: 0 },
  weekOff: { type: Number, default: 0 },
  holiday: { type: Number, default: 0 },
  grossSalary: { type: Number, default: 0 },
  basicSalary: { type: Number, default: 0 },
  allowanceSalary: { type: Number, default: 0 },
  earnings: { type: [amountItemSchema], default: [] },
  deductions: { type: [amountItemSchema], default: [] },
  leaveDeduction: { type: Number, default: 0 },
  pf: { type: Number, default: 0 },
  esi: { type: Number, default: 0 },
  professionTax: { type: Number, default: 0 },
  advancePayment: { type: Number, default: 0 },
  netSalary: { type: Number, default: 0 },
  paySlip: { type: String, default: '' },
  isPeriodConfig: { type: Boolean, default: false },
  payrollPeriodStatus: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active'
  }
}, { timestamps: true });

monthlyPayrollSchema.index({ hotelId: 1, staffId: 1, monthYear: 1 }, { unique: true });
monthlyPayrollSchema.index({ hotelId: 1, monthYear: 1, isPeriodConfig: 1 });

export const MonthlyPayroll =
  mongoose.models.MonthlyPayroll ||
  mongoose.model('MonthlyPayroll', monthlyPayrollSchema);
