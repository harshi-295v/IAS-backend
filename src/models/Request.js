import mongoose from 'mongoose'

const RequestSchema = new mongoose.Schema({
  facultyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Faculty', required: true },
  allocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Allocation', required: true },
  type: { type: String, enum: ['change','replacement'], required: true },
  reason: { type: String },
  status: { type: String, enum: ['pending','approved','rejected'], default: 'pending' },
  comments: { type: String },
  createdAt: { type: Date, default: Date.now },
})

// Prevent duplicate pending requests for the same allocation by the same faculty
RequestSchema.index(
  { facultyId: 1, allocationId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } }
)

export const Request = mongoose.model('Request', RequestSchema)
