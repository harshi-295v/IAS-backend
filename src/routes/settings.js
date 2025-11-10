import express from 'express'
import { Settings } from '../models/Settings.js'

const router = express.Router()

router.get('/constraints', async (_req, res) => {
  const doc = await Settings.findOne({ key: 'global' })
  res.json(doc?.constraints || { maxHoursPerDay: 2, noSameDayRepeat: true })
})

router.put('/constraints', async (req, res) => {
  const constraints = req.body || {}
  const doc = await Settings.findOneAndUpdate(
    { key: 'global' },
    { $set: { constraints, updatedAt: new Date() } },
    { new: true, upsert: true }
  )
  res.json(doc.constraints)
})

export default router
