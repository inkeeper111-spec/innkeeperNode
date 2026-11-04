import mongoose from 'mongoose';

const vendorSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  contactPerson: {
    type: String,
    default: ''
  },
  email: {
    type: String,
    lowercase: true,
    trim: true,
    default: ''
  },
  phone: {
    type: String,
    required: true
  },
  address: {
    type: String,
    default: ''
  },
  taxNumber: {
    type: String,
    default: ''
  },
  paymentTerms: {
    type: String,
    default: 'Net 30'
  },
  outstandingBalance: { type: Number, min: 0, default: 0 },
  suppliedItems: [{ type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem' }],
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active'
  }
}, {
  timestamps: true
});

export const Vendor = mongoose.models.Vendor || mongoose.model('Vendor', vendorSchema);
