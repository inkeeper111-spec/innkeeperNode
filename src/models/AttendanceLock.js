import mongoose from 'mongoose';

const attendanceLockSchema = new mongoose.Schema({
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
  monthYear: { type: String, required: true, index: true }, // YYYY-MM
  status: { type: String, enum: ['A'], default: 'A' }
}, { timestamps: true });

attendanceLockSchema.index(
  { hotelId: 1, staffId: 1, monthYear: 1 },
  { unique: true }
);

export const AttendanceLock =
  mongoose.models.AttendanceLock ||
  mongoose.model('AttendanceLock', attendanceLockSchema);
