import mongoose from 'mongoose';

const oldAdvanceDataSchema = new mongoose.Schema({
  breakupId: { type: mongoose.Schema.Types.ObjectId, required: true },
  payMonth: String,
  payAmount: Number,
  balanceAmount: Number,
  isPaid: String
}, { _id: false });

const payrollBackupSchema = new mongoose.Schema({
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
  monthYear: { type: String, required: true, index: true },
  oldAdvanceData: { type: [oldAdvanceDataSchema], default: [] }
}, { timestamps: true });

payrollBackupSchema.index({ hotelId: 1, staffId: 1, monthYear: 1 }, { unique: true });

export const PayrollBackup =
  mongoose.models.PayrollBackup ||
  mongoose.model('PayrollBackup', payrollBackupSchema);
