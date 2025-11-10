import mongoose from 'mongoose'

const ClassroomSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  building: { type: String },
  roomNumber: { type: String },
  capacity: { type: Number, default: 30 },
  createdAt: { type: Date, default: Date.now },
})

export const Classroom = mongoose.model('Classroom', ClassroomSchema)
