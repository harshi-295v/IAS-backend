import express from 'express'
import { generateScheduleForDate, getScheduleForDate, reassignAllocation } from '../services/scheduler.js'
import { Allocation } from '../models/Allocation.js'
import { FacultyRoster } from '../models/FacultyRoster.js'
import { Exam } from '../models/Exam.js'
import { Faculty } from '../models/Faculty.js'
import { sendMail } from '../lib/mailer.js'
// fresh upload flags are not enforced anymore

const router = express.Router()

router.post('/generate', async (req, res) => {
  try {
    const date = req.query.date || req.body.date
    if (!date) return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' })
    // Server-side guard: ensure collections have data and date has exams
    const [facCount, clsCount, exCount, exForDate] = await Promise.all([
      FacultyRoster.countDocuments({}),
      (await import('../models/Classroom.js')).Classroom.countDocuments({}),
      (await import('../models/Exam.js')).Exam.countDocuments({}),
      (await import('../models/Exam.js')).Exam.countDocuments({ date }),
    ])
    if (!facCount) return res.status(400).json({ error: 'Faculty file not uploaded' })
    if (!clsCount) return res.status(400).json({ error: 'Classrooms file not uploaded' })
    if (!exCount) return res.status(400).json({ error: 'Exams file not uploaded' })
    if (!exForDate) return res.status(400).json({ error: 'Exam not available' })
    const rows = await generateScheduleForDate(date)
    // Post-generation cleanup: delete uploaded faculty roster only; keep login accounts and other datasets
    try {
      const { Settings } = await import('../models/Settings.js')
      await FacultyRoster.deleteMany({})
      await Settings.updateOne(
        { key: 'uploadStatus' },
        { $unset: { facultyAt: '' } },
        { upsert: true }
      )
    } catch {}
    res.json({ date, count: rows.length, data: rows, cleaned: true })
  } catch (e) {
    res.status(500).json({ error: 'Generate failed', details: e.message })
  }
})

// Dangerous: reset all scheduling datasets so fresh uploads are required
router.delete('/reset-all', async (_req, res) => {
  try {
    const { Settings } = await import('../models/Settings.js')
    await Promise.all([
      FacultyRoster.deleteMany({}),
    ])
    await Settings.updateOne(
      { key: 'uploadStatus' },
      { $unset: { facultyAt: '' } },
      { upsert: true }
    )
    res.json({ reset: true })
  } catch (e) {
    res.status(500).json({ error: 'Reset failed', details: e.message })
  }
})

// Fetch single allocation by id (for admin workflows)
router.get('/allocation/:id', async (req, res) => {
  try {
    const { id } = req.params
    const row = await Allocation.findById(id).populate('invigilatorId', 'name email department designation').lean()
    if (!row) return res.status(404).json({ error: 'Not found' })
    res.json(row)
  } catch (e) {
    res.status(500).json({ error: 'Fetch failed', details: e.message })
  }
})

router.get('/day', async (req, res) => {
  try {
    const { date } = req.query
    if (!date) return res.status(400).json({ error: 'date is required' })
    const rows = await getScheduleForDate(date)
    res.json({ date, data: rows })
  } catch (e) {
    res.status(500).json({ error: 'Fetch failed', details: e.message })
  }
})

// Clear all allocations for a specific date and adjust faculty loads
router.delete('/day', async (req, res) => {
  try {
    const { date } = req.query
    if (!date) return res.status(400).json({ error: 'date is required' })
    const rows = await Allocation.find({ date }).lean()
    if (!rows.length) return res.json({ date, deleted: 0 })
    const perFaculty = new Map()
    for (const r of rows) {
      const fid = String(r.invigilatorId)
      perFaculty.set(fid, (perFaculty.get(fid) || 0) + 1)
    }
    await Allocation.deleteMany({ date })
    // build bulk ops to decrement currentLoad and clear dailyLoad for the date
    const ops = []
    for (const [fid, cnt] of perFaculty.entries()) {
      ops.push({
        updateOne: {
          filter: { _id: fid },
          update: { $inc: { currentLoad: -cnt }, $unset: { ["dailyLoad."+date]: "" } }
        }
      })
    }
    if (ops.length) await Faculty.bulkWrite(ops)
    res.json({ date, deleted: rows.length, adjusted: ops.length })
  } catch (e) {
    res.status(500).json({ error: 'Clear failed', details: e.message })
  }
})

// Distinct exam dates to highlight in calendar
router.get('/exam-dates', async (_req, res) => {
  try {
    const dates = await Exam.distinct('date')
    res.json({ dates })
  } catch (e) {
    res.status(500).json({ error: 'Failed to load exam dates', details: e.message })
  }
})

// Schedule history: list dates with allocation counts
router.get('/history', async (_req, res) => {
  try {
    const items = await Allocation.aggregate([
      { $group: { _id: '$date', count: { $sum: 1 } } },
      { $sort: { _id: -1 } }
    ])
    const list = items.map(x => ({ date: x._id, count: x.count }))
    res.json({ history: list })
  } catch (e) {
    res.status(500).json({ error: 'Failed to load schedule history', details: e.message })
  }
})

router.patch('/reassign/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { toFacultyId } = req.body
    if (!toFacultyId) return res.status(400).json({ error: 'toFacultyId required' })
    const updated = await reassignAllocation(id, toFacultyId)
    const full = await Allocation.findById(updated._id).populate('invigilatorId', 'name email').lean()
    if (full?.invigilatorId?.email) {
      const subject = `Updated Invigilation Duty on ${full.date} (${full.slot})`
      const html = `<p>Dear ${full.invigilatorId.name},</p>
        <p>You have been assigned invigilation in room <b>${full.classroomCode}</b> on <b>${full.date}</b> (${full.slot}).</p>
        <p>Regards,<br/>Exam Cell</p>`
      await sendMail({ to: full.invigilatorId.email, subject, html, text: subject })
    }
    res.json(full || updated)
  } catch (e) {
    res.status(500).json({ error: 'Reassign failed', details: e.message })
  }
})

router.get('/export/day.csv', async (req, res) => {
  try {
    const { date } = req.query
    if (!date) return res.status(400).json({ error: 'date is required' })
    const rows = await Allocation.find({ date }).populate('invigilatorId', 'name email department designation').lean()
    const header = ['date','slot','classroomCode','invigilatorName','email','department','designation']
    const csv = [header.join(',')].concat(rows.map(r => [
      r.date,
      r.slot,
      r.classroomCode,
      r.invigilatorId?.name || '',
      r.invigilatorId?.email || '',
      r.invigilatorId?.department || '',
      r.invigilatorId?.designation || ''
    ].map(v => `"${String(v).replaceAll('"','\"')}"`).join(','))).join('\n')
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="schedule_${date}.csv"`)
    res.send(csv)
  } catch (e) {
    res.status(500).json({ error: 'Export failed', details: e.message })
  }
})

router.post('/notify/day', async (req, res) => {
  try {
    const date = req.query.date || req.body.date
    if (!date) return res.status(400).json({ error: 'date is required' })
    const rows = await Allocation.find({ date }).populate('invigilatorId', 'name email').lean()
    let sent = 0, previews = []
    const appUrl = process.env.APP_BASE_URL || 'http://localhost:5173'

    for (const r of rows) {
      if (!r.invigilatorId?.email) continue
      const subject = `Invigilation Duty • ${r.date} • ${r.slot} • Room ${r.classroomCode}`
      const text = `Dear ${r.invigilatorId.name},\n\n`+
        `You are assigned invigilation duty.\n`+
        `Date: ${r.date}\n`+
        `Slot: ${r.slot}\n`+
        `Room: ${r.classroomCode}\n\n`+
        `View schedule: ${appUrl}\n`+
        `Regards, Exam Cell`
      const html = `
        <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">
          <div style="background:#1f2937;color:#fff;padding:14px 18px;font-size:16px;font-weight:600">Invigilation Duty</div>
          <div style="padding:16px 18px;color:#111827;font-size:14px;line-height:1.6">
            <p style="margin:0 0 12px 0">Dear ${r.invigilatorId.name},</p>
            <p style="margin:0 0 14px 0">You have been scheduled for invigilation duty as per the details below.</p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:8px 0 14px 0">
              <tbody>
                <tr>
                  <td style="padding:8px 10px;border:1px solid #e5e7eb;background:#f9fafb;width:32%">Date</td>
                  <td style="padding:8px 10px;border:1px solid #e5e7eb">${r.date}</td>
                </tr>
                <tr>
                  <td style="padding:8px 10px;border:1px solid #e5e7eb;background:#f9fafb">Slot</td>
                  <td style="padding:8px 10px;border:1px solid #e5e7eb">${r.slot}</td>
                </tr>
                <tr>
                  <td style="padding:8px 10px;border:1px solid #e5e7eb;background:#f9fafb">Room</td>
                  <td style="padding:8px 10px;border:1px solid #e5e7eb">${r.classroomCode}</td>
                </tr>
              </tbody>
            </table>
            <div style="margin:16px 0 4px 0">
              <a href="${appUrl}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 14px;border-radius:8px">Open Portal</a>
            </div>
            <p style="margin:14px 0 0 0;color:#374151">Regards,<br/>Exam Cell</p>
          </div>
        </div>`
      const out = await sendMail({ to: r.invigilatorId.email, subject, html, text })
      sent += 1
      if (out.previewUrl) previews.push(out.previewUrl)
    }
    res.json({ sent, previews })
  } catch (e) {
    res.status(500).json({ error: 'Notify failed', details: e.message })
  }
})

export default router
