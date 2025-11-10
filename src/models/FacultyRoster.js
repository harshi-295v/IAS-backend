import mongoose from 'mongoose'

const AvailabilitySchema = new mongoose.Schema({
  date: { type: String },
  dayOfWeek: { type: Number, min: 0, max: 6 },
  slots: [{ type: String }],
}, { _id: false })

const FacultyRosterSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, index: true }, // not unique; accounts hold uniqueness
  department: { type: String, required: true },
  designation: { type: String, required: true },
  availability: [AvailabilitySchema],
  maxHoursPerDay: { type: Number, default: 2 },
  weeklyCap: { type: Number, default: 10 },
  createdAt: { type: Date, default: Date.now },
})

export const FacultyRoster = mongoose.model('FacultyRoster', FacultyRosterSchema)
