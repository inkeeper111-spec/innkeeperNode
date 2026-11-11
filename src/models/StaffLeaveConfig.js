import mongoose from 'mongoose';

const staffLeaveConfigSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    index: true
  },
  year: { type: Number, required: true, index: true },
  PL: { type: Number, default: 0, min: 0 },
  SL: { type: Number, default: 0, min: 0 },
  EL: { type: Number, default: 0, min: 0 },
  CL: { type: Number, default: 0, min: 0 }
}, { timestamps: true });

staffLeaveConfigSchema.index({ hotelId: 1, year: 1 }, { unique: true });

export const StaffLeaveConfig =
  mongoose.models.StaffLeaveConfig ||
  mongoose.model('StaffLeaveConfig', staffLeaveConfigSchema);
