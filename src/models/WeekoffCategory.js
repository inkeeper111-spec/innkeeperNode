import mongoose from 'mongoose';

const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

const weekDaysSchema = new mongoose.Schema({
  week1: { type: [String], default: [] },
  week2: { type: [String], default: [] },
  week3: { type: [String], default: [] },
  week4: { type: [String], default: [] },
  week5: { type: [String], default: [] }
}, { _id: false });

const weekoffCategorySchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    index: true
  },
  categoryName: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  weekOff: { type: weekDaysSchema, default: () => ({}) },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

weekoffCategorySchema.index({ hotelId: 1, categoryName: 1 }, { unique: true });

export { DAY_NAMES };
export const WeekoffCategory =
  mongoose.models.WeekoffCategory ||
  mongoose.model('WeekoffCategory', weekoffCategorySchema);
