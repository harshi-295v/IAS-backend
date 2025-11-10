import express from 'express'
import multer from 'multer'
import { parseCsv } from '../lib/csv.js'
import { Faculty } from '../models/Faculty.js'
import { FacultyRoster } from '../models/FacultyRoster.js'
import { Classroom } from '../models/Classroom.js'
import { Exam } from '../models/Exam.js'
import { Settings } from '../models/Settings.js'

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage() })

// Normalize various common date formats to YYYY-MM-DD
function normDate(val) {
  const s = String(val||'').trim()
  if (!s) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  // DD-MM-YYYY or DD/MM/YYYY
  let m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/)
  if (m) {
    const [_, d, mo, y] = m
    const dd = String(d).padStart(2,'0')
    const mm = String(mo).padStart(2,'0')
    return `${y}-${mm}-${dd}`
  }
  return s
}

// Decoupled upload for credential generation only (does not touch FacultyRoster or uploadStatus)
router.post('/credentials', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    const isCsvName = /\.csv$/i.test(req.file.originalname || '')
    const isCsvType = ['text/csv', 'application/vnd.ms-excel'].includes(req.file.mimetype)
    if (!isCsvName || !isCsvType) return res.status(400).json({ error: 'Only CSV files are allowed' })
    const raw = parseCsv(req.file.buffer)
    // Normalize and extract emails+basic fields (not persisted)
    const normed = raw.map(r => {
      const low = {}
      for (const k of Object.keys(r || {})) {
        const v = r[k]
        if (v == null) continue
        low[String(k).trim().toLowerCase()] = String(v).trim()
      }
      const name = low.name || low.fullname || low['full name'] || ''
      const email = (low.email || low['e-mail'] || low.mail || '').toLowerCase()
      return { name, email }
    })
    // Filter invalid rows and dedupe by email
    const seen = new Set()
    const emails = []
    for (const r of normed) {
      if (!r.email || !r.name) continue
      if (seen.has(r.email)) continue
      seen.add(r.email)
      emails.push(r.email)
    }
    res.json({ imported: emails.length, emails })
  } catch (e) {
    res.status(500).json({ error: 'Credentials upload failed', details: e.message })
  }
})

// Status endpoint: are required files uploaded?
router.get('/status', async (req, res) => {
  try {
    const [fac, cls, exams] = await Promise.all([
      FacultyRoster.countDocuments({}),
      Classroom.countDocuments({}),
      Exam.countDocuments({}),
    ])
    const date = req.query.date
    let examsForDate = undefined
    if (date) {
      examsForDate = await Exam.countDocuments({ date })
    }
    const flags = await Settings.findOne({ key: 'uploadStatus' }).lean()
    const uploaded = {
      faculty: !!flags?.facultyAt,
      classrooms: !!flags?.classroomsAt,
      exams: !!flags?.examsAt,
    }
    res.json({ faculty: fac, classrooms: cls, exams, examsForDate, uploaded, timestamps: { facultyAt: flags?.facultyAt, classroomsAt: flags?.classroomsAt, examsAt: flags?.examsAt } })
  } catch (e) {
    res.status(500).json({ error: 'Failed to read upload status', details: e.message })
  }
})

router.post('/faculty', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    const isCsvName = /\.csv$/i.test(req.file.originalname || '')
    const isCsvType = ['text/csv', 'application/vnd.ms-excel'].includes(req.file.mimetype)
    if (!isCsvName || !isCsvType) return res.status(400).json({ error: 'Only CSV files are allowed' })
    const raw = parseCsv(req.file.buffer)
    // Normalize headers case-insensitively and trim values
    const normed = raw.map(r => {
      const low = {}
      for (const k of Object.keys(r || {})) {
        const v = r[k]
        if (v == null) continue
        low[String(k).trim().toLowerCase()] = String(v).trim()
      }
      const name = low.name || low.fullname || low['full name'] || ''
      const email = (low.email || low['e-mail'] || low.mail || '').toLowerCase()
      const department = low.department || low.dept || 'FACULTY'
      const designation = low.designation || low.title || 'FACULTY'
      const maxHoursPerDay = Number(low.maxhoursperday || low['max hours per day'] || 2)
      const weeklyCap = Number(low.weeklycap || low['weekly cap'] || 10)
      return { name, email, department, designation, maxHoursPerDay, weeklyCap }
    })
    // Filter invalid rows
    const valid = normed.filter(r => r.email && r.name)
    // Deduplicate by email (keep first occurrence)
    const seen = new Set()
    const unique = []
    for (const r of valid) { if (!seen.has(r.email)) { seen.add(r.email); unique.push(r) } }
    const ops = unique.map(r => ({
      updateOne: {
        filter: { email: r.email },
        update: { $set: r },
        upsert: true
      }
    }))
    if (ops.length) await FacultyRoster.bulkWrite(ops)
    await Settings.updateOne({ key: 'uploadStatus' }, { $set: { key: 'uploadStatus', facultyAt: new Date() } }, { upsert: true })
    res.json({ imported: ops.length, emails: unique.map(r => r.email) })
  } catch (e) {
    res.status(500).json({ error: 'Faculty upload failed', details: e.message })
  }
})

router.post('/classrooms', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    const isCsvName = /\.csv$/i.test(req.file.originalname || '')
    const isCsvType = ['text/csv', 'application/vnd.ms-excel'].includes(req.file.mimetype)
    if (!isCsvName || !isCsvType) return res.status(400).json({ error: 'Only CSV files are allowed' })
    const raw = parseCsv(req.file.buffer)
    // Normalize headers and map fields
    const rows = raw.map(r0 => {
      const r = {}
      for (const k of Object.keys(r0||{})) r[String(k).trim().toLowerCase()] = String(r0[k]).trim()
      const code = r.code || r.classroom || r.classroomcode || r.room || r['room code']
      const building = r.building || ''
      const roomNumber = r.roomnumber || r['room number'] || ''
      const capacity = Number(r.capacity || r.cap || 30)
      return { code, building, roomNumber, capacity }
    }).filter(r => !!r.code)
    const ops = rows.map(r => ({
      updateOne: {
        filter: { code: r.code },
        update: { $set: {
          code: r.code,
          building: r.building,
          roomNumber: r.roomNumber,
          capacity: Number(r.capacity || 30)
        } },
        upsert: true
      }
    }))
    if (ops.length) await Classroom.bulkWrite(ops)
    await Settings.updateOne({ key: 'uploadStatus' }, { $set: { key: 'uploadStatus', classroomsAt: new Date() } }, { upsert: true })
    res.json({ imported: ops.length })
  } catch (e) {
    res.status(500).json({ error: 'Classrooms upload failed', details: e.message })
  }
})

router.post('/exams', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    const isCsvName = /\.csv$/i.test(req.file.originalname || '')
    const isCsvType = ['text/csv', 'application/vnd.ms-excel'].includes(req.file.mimetype)
    if (!isCsvName || !isCsvType) return res.status(400).json({ error: 'Only CSV files are allowed' })
    const raw = parseCsv(req.file.buffer)
    // Normalize headers; expected aliases handled below
    const rows = raw.map(r0 => {
      const r = {}
      for (const k of Object.keys(r0||{})) r[String(k).trim().toLowerCase()] = String(r0[k]).trim()
      return {
        courseCode: r.coursecode || r['course code'] || r.code,
        courseName: r.coursename || r['course name'] || r.name,
        date: normDate(r.date),
        slot: String(r.slot||'').toUpperCase(),
        classroomCode: (r.classroomcode || r.room || r['room code'] || '').toUpperCase(),
        neededInvigilators: Number(r.neededinvigilators || r.invigilators || r['needed invigilators'] || 1)
      }
    }).filter(r => r.courseCode && r.date && r.slot)
    // Expected columns now: courseCode,courseName,date,slot,classroomCode,neededInvigilators
    // Group by courseCode+date+slot
    const map = new Map()
    for (const r of rows) {
      const key = `${r.courseCode}|${r.date}|${r.slot}`
      if (!map.has(key)) map.set(key, {
        courseCode: r.courseCode,
        courseName: r.courseName,
        date: r.date,
        slot: r.slot,
        rooms: []
      })
      if (r.classroomCode) map.get(key).rooms.push({ classroomCode: r.classroomCode, neededInvigilators: Number(r.neededInvigilators || 1) })
    }
    const upserts = []
    for (const value of map.values()) {
      upserts.push({
        updateOne: {
          filter: { courseCode: value.courseCode, date: value.date, slot: value.slot },
          update: { $set: value },
          upsert: true
        }
      })
    }
    if (upserts.length) await Exam.bulkWrite(upserts)
    await Settings.updateOne({ key: 'uploadStatus' }, { $set: { key: 'uploadStatus', examsAt: new Date() } }, { upsert: true })
    res.json({ imported: rows.length, grouped: upserts.length })
  } catch (e) {
    res.status(500).json({ error: 'Exams upload failed', details: e.message })
  }
})

export default router
