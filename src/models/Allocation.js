import mongoose from 'mongoose'

const AllocationSchema = new mongoose.Schema({
  examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
  date: { type: String, required: true },
  slot: { type: String, enum: ['FN','AN','EV'], required: true },
  classroomCode: { type: String, required: true },
  invigilatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Faculty', required: true },
  status: { type: String, enum: ['assigned','pending','replaced','cancelled'], default: 'assigned' },
  notes: { type: String },
  createdAt: { type: Date, default: Date.now },
})

export const Allocation = mongoose.model('Allocation', AllocationSchema)
