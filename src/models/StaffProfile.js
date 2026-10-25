import mongoose from 'mongoose';

const staffProfileSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  employeeId: {
    type: String,
    required: true
  },
  department: {
    type: String,
    enum: ['front_desk', 'housekeeping', 'restaurant', 'maintenance', 'management', 'accounts', 'security'],
    default: 'front_desk'
  },
  designation: {
    type: String,
    required: true
  },
  salary: {
    type: Number,
    default: 0
  },
  basicSalary: {
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
  joiningDate: {
    type: Date,
    default: Date.now
  },
  emergencyContact: {
    name: String,
    relation: String,
    phone: String
  },
  status: {
    type: String,
    enum: ['active', 'on_leave', 'terminated'],
    default: 'active'
  }
}, {
  timestamps: true
});

staffProfileSchema.index({ hotelId: 1, employeeId: 1 }, { unique: true });

export const StaffProfile = mongoose.models.StaffProfile || mongoose.model('StaffProfile', staffProfileSchema);

