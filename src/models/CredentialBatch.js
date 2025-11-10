import mongoose from 'mongoose'

const CredentialEntrySchema = new mongoose.Schema({
  id: { type: String },
  name: { type: String },
  email: { type: String },
  department: { type: String },
  designation: { type: String },
  loginId: { type: String },
  password: { type: String },
}, { _id: false })

const CredentialBatchSchema = new mongoose.Schema({
  type: { type: String, enum: ['bulk','single'], default: 'bulk' },
  label: { type: String },
  credentials: [CredentialEntrySchema],
  createdAt: { type: Date, default: Date.now },
}, { minimize: true })

export const CredentialBatch = mongoose.model('CredentialBatch', CredentialBatchSchema)
