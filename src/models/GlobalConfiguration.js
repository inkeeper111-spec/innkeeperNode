import mongoose from 'mongoose';

const globalConfigurationSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    unique: true,
    index: true
  },
  attendanceCutoffDay: {
    type: Number,
    required: true,
    min: 1,
    max: 31
  },
  payrollCutoffDay: {
    type: Number,
    required: true,
    min: 1,
    max: 31
  }
}, { timestamps: true });

export const GlobalConfiguration =
  mongoose.models.GlobalConfiguration ||
  mongoose.model('GlobalConfiguration', globalConfigurationSchema);
