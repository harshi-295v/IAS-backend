import mongoose from 'mongoose'

const SettingsSchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  constraints: {
    maxHoursPerDay: { type: Number, default: 2 },
    noSameDayRepeat: { type: Boolean, default: true },
    departmentWeighting: { type: Map, of: Number, default: {} },
    designationWeighting: { type: Map, of: Number, default: {} },
  },
  updatedAt: { type: Date, default: Date.now },
})

export const Settings = mongoose.model('Settings', SettingsSchema)
