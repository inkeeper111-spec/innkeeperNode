import mongoose from 'mongoose';

const requestLineSchema = new mongoose.Schema({
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
  quantity: { type: Number, required: true, min: 0.000001 },
  issuedQuantity: { type: Number, min: 0, default: 0 },
  unit: { type: String, trim: true, default: '' }
}, { _id: false });

const departmentRequestSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true, index: true },
  department: { type: String, required: true, trim: true, index: true },
  lines: { type: [requestLineSchema], required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'partially_issued', 'issued'], default: 'pending', index: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  approvedAt: Date,
  notes: { type: String, trim: true, default: '' }
}, { timestamps: true });

export const DepartmentRequest = mongoose.models.DepartmentRequest
  || mongoose.model('DepartmentRequest', departmentRequestSchema);
