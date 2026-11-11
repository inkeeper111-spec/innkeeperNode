import mongoose from 'mongoose';

const staffBulkUploadsLogSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    index: true
  },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  fileName: { type: String, default: '' },
  filePath: { type: String, default: '' },
  totalRows: { type: Number, default: 0 },
  successCount: { type: Number, default: 0 },
  failCount: { type: Number, default: 0 },
  uploadStatus: { type: String, enum: ['S', 'F', 'PS'], default: 'F' },
  errors: { type: [String], default: [] }
}, { timestamps: true });

export const StaffBulkUploadsLog =
  mongoose.models.StaffBulkUploadsLog ||
  mongoose.model('StaffBulkUploadsLog', staffBulkUploadsLogSchema);
