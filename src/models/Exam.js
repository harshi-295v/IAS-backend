import mongoose from 'mongoose'

const ExamRoomSchema = new mongoose.Schema({
  classroomCode: { type: String, required: true },
  neededInvigilators: { type: Number, default: 1 },
}, { _id: false })

const ExamSchema = new mongoose.Schema({
  courseCode: { type: String, required: true },
  courseName: { type: String, required: true },
  date: { type: String, required: true }, // YYYY-MM-DD
  slot: { type: String, enum: ['FN','AN','EV'], required: true },
  rooms: [ExamRoomSchema],
  createdAt: { type: Date, default: Date.now },
})

export const Exam = mongoose.model('Exam', ExamSchema)
