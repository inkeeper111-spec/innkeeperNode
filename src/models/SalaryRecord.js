import mongoose from 'mongoose';

const salaryRecordSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    index: true
  },
  staffProfileId: {
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
  // e.g. "2026-10" — month this salary covers
  month: {
    type: String,
    required: true,
    index: true
  },
  baseSalary: {
    type: Number,
    required: true,
    min: 0
  },
  // Attendance-based deductions
  workingDays: {
    type: Number,
    default: 0
  },
  presentDays: {
    type: Number,
    default: 0
  },
  absentDays: {
    type: Number,
    default: 0
  },
  halfDays: {
    type: Number,
    default: 0
  },
  leaveDays: {
    type: Number,
    default: 0
  },
  // Calculated amounts
  earnedSalary: {
    type: Number,
    required: true,
    min: 0
  },
  deductionAmount: {
    type: Number,
    default: 0
  },
  bonusAmount: {
    type: Number,
    default: 0
  },
  allowances: {
    type: Number,
    default: 0
  },
  fixedDeductions: {
    type: Number,
    default: 0
  },
  advanceAmount: {
    type: Number,
    default: 0
  },
  netSalary: {
    type: Number,
    required: true,
    min: 0
  },
  paymentMethod: {
    type: String,
    enum: ['bank_transfer', 'cash', 'cheque', 'upi'],
    default: 'bank_transfer'
  },
  status: {
    type: String,
    enum: ['pending', 'processed', 'paid'],
    default: 'pending',
    index: true
  },
  // Link to the expense entry auto-created when salary is paid
  expenseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Expense',
    default: null
  },
  notes: {
    type: String,
    default: ''
  },
  processedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  processedAt: Date
}, {
  timestamps: true
});

// Prevent duplicate salary for same staff in same month
salaryRecordSchema.index({ hotelId: 1, userId: 1, month: 1 }, { unique: true });

export const SalaryRecord = mongoose.models.SalaryRecord || mongoose.model('SalaryRecord', salaryRecordSchema);
