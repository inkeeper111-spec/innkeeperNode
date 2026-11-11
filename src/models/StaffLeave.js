import mongoose from 'mongoose';

const staffLeaveSchema = new mongoose.Schema({
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
  year: { type: Number, required: true, index: true },
  monthYear: { type: String, required: true }, // YYYY-MM
  PL: { type: Number, default: 0, min: 0 },
  SL: { type: Number, default: 0, min: 0 },
  EL: { type: Number, default: 0, min: 0 },
  CL: { type: Number, default: 0, min: 0 }
}, { timestamps: true });

staffLeaveSchema.index({ hotelId: 1, staffId: 1, monthYear: 1 }, { unique: true });

export const StaffLeave =
  mongoose.models.StaffLeave ||
  mongoose.model('StaffLeave', staffLeaveSchema);
