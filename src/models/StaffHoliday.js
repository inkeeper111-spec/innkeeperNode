import mongoose from 'mongoose';

const staffHolidaySchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    index: true
  },
  holidayName: { type: String, required: true, trim: true },
  date: { type: Date, required: true, index: true },
  type: {
    type: String,
    enum: ['National', 'Festival', 'Optional'],
    default: 'National'
  },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

staffHolidaySchema.index({ hotelId: 1, date: 1 });

export const StaffHoliday =
  mongoose.models.StaffHoliday ||
  mongoose.model('StaffHoliday', staffHolidaySchema);
