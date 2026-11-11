import mongoose from 'mongoose';

const fieldSchema = new mongoose.Schema({
  key: { type: String, required: true },
  label: { type: String, required: true },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true }
}, { _id: false });

const payrollExportConfigSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    unique: true,
    index: true
  },
  fields: { type: [fieldSchema], default: [] },
  fileType: { type: String, enum: ['excel', 'pdf', 'txt'], default: 'excel' },
  format: { type: String, default: 'standard' },
  isWithoutHeader: { type: Boolean, default: false }
}, { timestamps: true });

export const DEFAULT_EXPORT_FIELDS = [
  { key: 'employeeId', label: 'Employee ID', order: 1, isActive: true },
  { key: 'name', label: 'Name', order: 2, isActive: true },
  { key: 'monthYear', label: 'Month', order: 3, isActive: true },
  { key: 'present', label: 'Present', order: 4, isActive: true },
  { key: 'leave', label: 'Leave', order: 5, isActive: true },
  { key: 'lop', label: 'LOP', order: 6, isActive: true },
  { key: 'weekOff', label: 'Week Off', order: 7, isActive: true },
  { key: 'holiday', label: 'Holiday', order: 8, isActive: true },
  { key: 'grossSalary', label: 'Gross', order: 9, isActive: true },
  { key: 'basicSalary', label: 'Basic', order: 10, isActive: true },
  { key: 'pf', label: 'PF', order: 11, isActive: true },
  { key: 'esi', label: 'ESI', order: 12, isActive: true },
  { key: 'professionTax', label: 'Profession Tax', order: 13, isActive: true },
  { key: 'advancePayment', label: 'Advance', order: 14, isActive: true },
  { key: 'netSalary', label: 'Net Salary', order: 15, isActive: true },
  { key: 'accountNo', label: 'Account No', order: 16, isActive: true },
  { key: 'IFSC', label: 'IFSC', order: 17, isActive: true },
  { key: 'accountName', label: 'Account Name', order: 18, isActive: true }
];

export const PayrollExportConfig =
  mongoose.models.PayrollExportConfig ||
  mongoose.model('PayrollExportConfig', payrollExportConfigSchema);
