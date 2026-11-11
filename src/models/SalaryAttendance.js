import mongoose from 'mongoose';

/** Payroll calendar attendance (distinct from ops Attendance check-in) */
const salaryAttendanceSchema = new mongoose.Schema({
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
  attendanceDate: { type: Date, required: true, index: true },
  status: {
    type: String,
    enum: ['P', 'L', 'EL', 'PL', 'SL', 'CL', 'W', 'H', 'A'],
    required: true
  },
  notes: { type: String, default: '' }
}, { timestamps: true });

salaryAttendanceSchema.index(
  { hotelId: 1, staffId: 1, attendanceDate: 1 },
  { unique: true }
);

export const SalaryAttendance =
  mongoose.models.SalaryAttendance ||
  mongoose.model('SalaryAttendance', salaryAttendanceSchema);
