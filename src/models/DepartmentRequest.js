import mongoose from 'mongoose';

const requestLineSchema = new mongoose.Schema({
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
  quantity: { type: Number, required: true, min: 0.00000001 },
  baseQuantity: { type: Number, min: 0.00000001, default: null },
  issuedQuantity: { type: Number, min: 0, default: 0 },
  issuedEnteredQuantity: { type: Number, min: 0, default: null },
  issuedUnit: { type: String, trim: true, default: '' },
  issuedConversionFactor: { type: Number, min: 0, default: 1 },
  unit: { type: String, trim: true, default: '' },
  conversionFactor: { type: Number, min: 0, default: 1 }
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
