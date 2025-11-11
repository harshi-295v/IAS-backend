import express from 'express'
import { Allocation } from '../models/Allocation.js'
import { FacultyRoster } from '../models/FacultyRoster.js'
import { Request as Req } from '../models/Request.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { Faculty } from '../models/Faculty.js'
import { hashPassword } from '../lib/hash.js'
import { sendMail } from '../lib/mailer.js'
import { CredentialBatch } from '../models/CredentialBatch.js'

const router = express.Router()

function buildCredsEmailHtml({ name, loginId, password, loginUrl }) {
  const safeName = name || 'Faculty'
  const url = loginUrl
  return `
  <div style="font-family: Arial, Helvetica, sans-serif; line-height: 1.6; color: #111;">
    <div style="max-width: 640px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden;">
      <div style="background: #0ea5e9; color: white; padding: 16px 20px; text-align:center;">
        <h1 style="margin:0; font-size:20px;">Invigilator Allocation System</h1>
      </div>
      <div style="padding: 18px 20px;">
        <p style="margin:0 0 10px 0;">Dear <b>${safeName}</b>,</p>
        <p style="margin:0 0 14px 0;">Your portal credentials have been generated:</p>
        <div style="background:#f8fafc; border:1px solid #e5e7eb; border-radius:8px; padding:12px 14px; margin-bottom:14px;">
          <p style="margin:4px 0;">Login ID: <b>${loginId}</b></p>
          <p style="margin:4px 0;">Password: <b>${password}</b></p>
        </div>
        <div style="margin: 16px 0;">
          <a href="${url}" style="display:inline-block; background:#4f46e5; color:#ffffff; text-decoration:none; padding:10px 16px; border-radius:6px;">Login to Portal</a>
        </div>
        <p style="margin: 12px 0 0 0; font-size: 13px; color:#374151;">Please use these credentials to login.<br/>
          If the button doesn’t work, copy and paste this link into your browser:<br/>
          <span style="color:#2563eb; word-break: break-all;">${url}</span>
        </p>
        <p style="margin: 18px 0 0 0;">Regards,<br/>Admin</p>
      </div>
    </div>
  </div>`
}

// Helpers to generate faculty credentials per requested formats
function randomDigit() { return Math.floor(Math.random() * 10) }
function randomUpper() { return String.fromCharCode(65 + Math.floor(Math.random() * 26)) }
function randomLower() { return String.fromCharCode(97 + Math.floor(Math.random() * 26)) }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)] }

// Login ID: 6 length including 'Vu', one special character, '-', and two integers.
// Format: Vu + <special> + '-' + <digit><digit>  e.g., Vu@-12
function makeFacultyLoginId(existing, reserved) {
  const specials = ['@', '#', '$', '%', '&', '*']
  let id
  do {
    id = 'Vu' + pick(specials) + '-' + randomDigit() + randomDigit()
  } while (existing.has(id) || reserved.has(id))
  reserved.add(id)
  return id
}

// Password: 6 length, one uppercase, two lowercase, '@', and two integers.
// Format: <Upper><lower><lower>@<digit><digit>  e.g., Abc@12
function makeFacultyPassword() {
  return randomUpper() + randomLower() + randomLower() + '@' + randomDigit() + randomDigit()
}

// Get my allocations
router.get('/me/allocations', requireAuth, async (req, res) => {
  const userId = req.user?.id
  const rows = await Allocation.find({ invigilatorId: userId })
    .populate('invigilatorId', 'name email department designation')
    .lean()
  res.json(rows)
})

// Submit change/replacement request
router.post('/requests', requireAuth, async (req, res) => {
  const userId = req.user?.id
  const { allocationId, type = 'change', reason = '' } = req.body
  if (!allocationId) return res.status(400).json({ error: 'allocationId required' })
  // Upsert to avoid duplicate pending requests for same allocation and faculty
  let doc
  try {
    doc = await Req.findOneAndUpdate(
      { facultyId: userId, allocationId, status: 'pending' },
      { $setOnInsert: { facultyId: userId, allocationId, type, createdAt: new Date() }, $set: { reason } },
      { new: true, upsert: true }
    )
  } catch (e) {
    // Handle rare race duplicate
    if (e && e.code === 11000) {
      doc = await Req.findOne({ facultyId: userId, allocationId, status: 'pending' })
    } else { throw e }
  }
  try {
    const fac = await Faculty.findById(userId).lean()
    const adminEmail = process.env.ADMIN_EMAIL
    if (adminEmail) {
      const subject = `New ${type} request from ${fac?.name || 'Faculty'}`
      const html = `<p>Faculty: <b>${fac?.name || ''}</b> (${fac?.email || ''})</p>
        <p>Allocation ID: ${allocationId}</p>
        <p>Type: ${type}</p>
        <p>Reason: ${reason || '-'}</p>
        <p>Please review and approve in the Admin Dashboard.</p>`
      await sendMail({ to: adminEmail, subject, html, text: subject })
    }
  } catch {}
  res.json(doc)
})

// List my requests
router.get('/requests', requireAuth, async (req, res) => {
  const userId = req.user?.id
  const rows = await Req.find({ facultyId: userId }).lean()
  res.json(rows)
})

// --- Admin: Generate credentials for faculties ---
router.post('/credentials/generate', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    let { force = false, targetIds, targetEmails, saveBatch = false, label, useRoster = false } = req.body || {}
    if (useRoster) {
      const rosterEmails = await FacultyRoster.distinct('email')
      targetEmails = rosterEmails.filter(Boolean)
      force = true
      if (!label) label = 'Bulk Credentials (Roster)'
    }
    // Include docs with role 'faculty' or missing role; exclude admin later explicitly
    const query = { $or: [ { role: 'faculty' }, { role: { $exists: false } } ] }
    if (Array.isArray(targetIds) && targetIds.length > 0) {
      query._id = { $in: targetIds }
    }
    if (Array.isArray(targetEmails) && targetEmails.length > 0) {
      query.email = { $in: targetEmails }
    }
    let list = await Faculty.find(query).lean()

    // If targeting by emails, ensure Faculty accounts exist for those emails
    if (Array.isArray(targetEmails) && targetEmails.length > 0) {
      const existingEmails = new Set(list.map(f => String(f.email).toLowerCase()))
      const needEmails = targetEmails.map(e => String(e).toLowerCase()).filter(e => !!e && !existingEmails.has(e))
      if (needEmails.length) {
        // Try from roster first
        let toCreate = []
        try {
          const rosterDocs = await FacultyRoster.find({ email: { $in: needEmails } }).lean()
          toCreate = rosterDocs.map(r => ({
            name: r.name || 'Faculty',
            email: r.email,
            department: r.department || 'FACULTY',
            designation: r.designation || 'FACULTY',
            role: 'faculty',
          }))
        } catch {}
        // Fallback: create minimal docs for any remaining emails not covered by roster
        const covered = new Set(toCreate.map(d => String(d.email).toLowerCase()))
        needEmails.forEach(em => { if (!covered.has(em)) toCreate.push({ name: 'Faculty', email: em, department: 'FACULTY', designation: 'FACULTY', role: 'faculty' }) })
        if (toCreate.length) {
          await Faculty.insertMany(toCreate, { ordered: false })
          list = await Faculty.find(query).lean()
        }
      }
    }

    // Filter to only those needing credentials (unless force)
    const targets = list.filter(f => f.role !== 'admin' && (force || !f.loginId || !f.passwordHash))
    if (targets.length === 0) {
      if (saveBatch) return res.json({ count: 0, credentials: [], batchId: undefined })
      return res.json({ count: 0, credentials: [] })
    }

    // Preload existing loginIds once and generate unique ids in-memory
    const existingIds = new Set((await Faculty.distinct('loginId')).filter(Boolean))
    const reserved = new Set()

    // Prepare plaintext credentials to return and hashed updates for DB
    const prepared = targets.map(f => {
      const loginId = f.loginId || makeFacultyLoginId(existingIds, reserved)
      const password = makeFacultyPassword()
      return { f, loginId, password }
    })

    // Hash passwords in parallel (bounded by Node's libuv threadpool; acceptable for typical sizes)
    const hashed = await Promise.all(prepared.map(async ({ f, loginId, password }) => ({
      id: String(f._id),
      name: f.name, email: f.email, department: f.department, designation: f.designation,
      loginId, password,
      passwordHash: await hashPassword(password),
    })))

    // Bulk write updates
    const ops = hashed.map(h => ({
      updateOne: {
        filter: { _id: h.id },
        update: { $set: { loginId: h.loginId, passwordHash: h.passwordHash, credentialGeneratedAt: new Date(), lastGeneratedLoginId: h.loginId, lastGeneratedPassword: h.password } },
      }
    }))
    if (ops.length) await Faculty.bulkWrite(ops)

    const credentials = hashed.map(h => ({ id: h.id, name: h.name, email: h.email, loginId: h.loginId, password: h.password, department: h.department, designation: h.designation }))

    if (saveBatch && credentials.length) {
      const batch = await CredentialBatch.create({ type: 'bulk', label: label || `Bulk ${new Date().toISOString()}`, credentials })
      return res.json({ count: credentials.length, credentials, batchId: batch._id })
    }
    res.json({ count: credentials.length, credentials })
  } catch (e) {
    res.status(500).json({ error: 'Credential generation failed', details: e.message })
  }
})

// --- Admin: Send credentials via email ---
router.post('/credentials/notify', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { credentials = [] } = req.body || {}
    if (!Array.isArray(credentials) || credentials.length === 0) {
      return res.status(400).json({ error: 'No credentials provided' })
    }

    // Respond immediately to avoid gateway timeouts; process in background
    const accepted = credentials.length
    res.status(202).json({ accepted, queued: true })

    // Background processing
    const limit = Number(process.env.MAIL_CONCURRENCY || 3)
    const queue = credentials.slice()
    const results = []

    const runWorker = async () => {
      while (queue.length) {
        const c = queue.shift()
        try {
          const fac = await Faculty.findOne({ $or: [ { _id: c.id }, { email: c.email }, { loginId: c.loginId } ] })
          if (!fac) throw new Error('Faculty not found')
          if (!fac.email) throw new Error('Missing faculty email')
          const subject = 'Your Invigilator Portal Credentials'
          const loginUrl = (process.env.APP_BASE_URL || 'http://localhost:5173') + '/auth/faculty/login'
          const html = buildCredsEmailHtml({ name: fac.name, loginId: c.loginId, password: c.password, loginUrl })
          const text = `Dear ${fac.name},\n\nYour portal credentials have been generated.\n\nLogin ID: ${c.loginId}\nPassword: ${c.password}\nLogin URL: ${loginUrl}\n\nRegards,\nAdmin`
          const info = await sendMail({ to: fac.email, subject, html, text })
          results.push({ email: fac.email, ok: true, previewUrl: info.previewUrl })
          console.log(`[notify] sent -> ${fac.email}`)
        } catch (err) {
          results.push({ email: c.email, ok: false, error: err.message })
          console.warn(`[notify] failed -> ${c.email}: ${err.message}`)
        }
      }
    }

    setImmediate(async () => {
      try {
        await Promise.all(Array.from({ length: Math.min(limit, credentials.length) }, () => runWorker()))
        const sent = results.filter(r => r.ok).length
        const failed = results.length - sent
        console.log(`[notify] completed: total=${results.length} sent=${sent} failed=${failed}`)
      } catch (err) {
        console.error('[notify] background error:', err)
      }
    })
  } catch (e) {
    res.status(500).json({ error: 'Notification sending failed', details: e.message })
  }
})

// --- Admin: Add faculty (create + credentials + email + batch) ---
router.post('/admin/add', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { name, email, department = 'FACULTY', designation = 'FACULTY', sendEmail = true } = req.body || {}
    if (!name || !email) return res.status(400).json({ error: 'name and email required' })
    const exists = await Faculty.findOne({ email })
    if (exists) return res.status(409).json({ error: 'Faculty already exists' })

    // Ensure loginId uniqueness on add
    const existingIds = new Set((await Faculty.distinct('loginId')).filter(Boolean))
    const reserved = new Set()
    const loginId = makeFacultyLoginId(existingIds, reserved)
    const passwordPlain = makeFacultyPassword()
    const passwordHash = await hashPassword(passwordPlain)
    const doc = await Faculty.create({ name, email, department, designation, role: 'faculty', loginId, passwordHash, credentialGeneratedAt: new Date(), lastGeneratedLoginId: loginId, lastGeneratedPassword: passwordPlain })

    const credentials = [{ id: String(doc._id), name, email, department, designation, loginId, password: passwordPlain }]
    const batch = await CredentialBatch.create({ type: 'single', label: `Add ${name}`, credentials })

    if (sendEmail) {
      const subject = 'Your Invigilator Portal Credentials'
      const loginUrl = (process.env.APP_BASE_URL || 'http://localhost:5173') + '/auth/faculty/login'
      const html = buildCredsEmailHtml({ name, loginId, password: passwordPlain, loginUrl })
      const text = `Dear ${name},\n\nYour portal credentials have been generated.\n\nLogin ID: ${loginId}\nPassword: ${passwordPlain}\nLogin URL: ${loginUrl}\n\nRegards,\nAdmin`
      await sendMail({ to: email, subject, html, text })
    }

    res.json({ faculty: { id: doc._id, name, email, department, designation }, credentials: credentials[0], batchId: batch._id })
  } catch (e) {
    res.status(500).json({ error: 'Add faculty failed', details: e.message })
  }
})

// --- Admin: Remove faculty (clear credentials or hard delete) ---
router.post('/admin/remove', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { id, email, loginId, hardDelete = false } = req.body || {}
    if (!id && !email && !loginId) return res.status(400).json({ error: 'id, email, or loginId required' })
    const fac = await Faculty.findOne({ $or: [ id ? { _id: id } : null, email ? { email } : null, loginId ? { loginId } : null ].filter(Boolean) })
    if (!fac) return res.status(404).json({ error: 'Faculty not found' })
    if (fac.role === 'admin') return res.status(400).json({ error: 'Cannot remove admin' })

    if (hardDelete) {
      await Faculty.deleteOne({ _id: fac._id })
      return res.json({ removed: true })
    } else {
      fac.loginId = undefined
      fac.passwordHash = undefined
      fac.credentialGeneratedAt = undefined
      await fac.save()
      return res.json({ removed: true })
    }
  } catch (e) {
    res.status(500).json({ error: 'Remove faculty failed', details: e.message })
  }
})

// --- Admin: Credential batches list and detail ---
router.get('/credentials/batches', requireAuth, requireRole('admin'), async (_req, res) => {
  const rows = await CredentialBatch.find().sort({ createdAt: -1 }).select('type label createdAt credentials').lean()
  const list = rows.map(r => ({ id: String(r._id), type: r.type, label: r.label, createdAt: r.createdAt, count: (r.credentials||[]).length }))
  res.json({ batches: list })
})

router.get('/credentials/batches/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params
  const row = await CredentialBatch.findById(id).lean()
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json({ id: String(row._id), type: row.type, label: row.label, createdAt: row.createdAt, credentials: row.credentials || [] })
})

export default router

// Admin search faculties (basic)
router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim()
  if (!q) return res.json([])
  const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  const list = await Faculty.find({
    $or: [
      { name: regex },
      { email: regex },
      { department: regex },
      { designation: regex },
    ]
  }).limit(20).select('name email department designation').lean()
  res.json(list)
})

// --- Admin: Requests listing and approval ---
router.get('/admin/requests', requireAuth, requireRole('admin'), async (req, res) => {
  const { status = 'pending' } = req.query
  const q = status ? { status } : {}
  // Exclude malformed docs proactively
  q.facultyId = { $ne: null }
  q.allocationId = { $ne: null }
  const rows = await Req.find(q)
    .sort({ createdAt: -1 })
    .populate('facultyId', 'name email department designation')
    .populate('allocationId', 'date slot classroomCode')
    .lean()
  // Filter malformed and dedupe by faculty+allocation for pending
  const seen = new Set()
  const clean = []
  for (const r of rows) {
    if (!r.facultyId || !r.allocationId) continue
    const key = `${String(r.facultyId._id)}|${String(r.allocationId._id)}|${r.status}`
    if (seen.has(key)) continue
    seen.add(key)
    clean.push(r)
  }
  res.json({ requests: clean })
})

router.post('/requests/:id/approve', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params
    const { comments = '', toFacultyId } = req.body || {}
    const row = await Req.findById(id)
    if (!row) return res.status(404).json({ error: 'Request not found' })

    // Optionally perform reassignment first
    let updatedAlloc = null
    if (toFacultyId) {
      const { reassignAllocation } = await import('../services/scheduler.js')
      updatedAlloc = await reassignAllocation(String(row.allocationId), String(toFacultyId))

      try {
        // Notify old and new faculty by email
        const alloc = await Allocation.findById(row.allocationId).lean()
        const [oldFac, newFac] = await Promise.all([
          Faculty.findById(alloc?.invigilatorId).lean(),
          Faculty.findById(toFacultyId).lean(),
        ])
        const { Exam } = await import('../models/Exam.js')
        const exam = alloc?.examId ? await Exam.findById(alloc.examId).lean() : null
        const subject = 'Invigilator Allocation Updated'
        const details = `Date: ${alloc?.date || ''}\nSlot: ${alloc?.slot || ''}\nRoom: ${alloc?.classroomCode || ''}\n${exam ? `Exam: ${exam.subject || ''}` : ''}`
        if (oldFac?.email) {
          await sendMail({ to: oldFac.email, subject, text: `Your allocation has been changed. ${details}`, html: `<p>Your allocation has been changed.</p><pre>${details}</pre>` })
        }
        if (newFac?.email) {
          await sendMail({ to: newFac.email, subject, text: `You have a new allocation. ${details}`, html: `<p>You have a new allocation.</p><pre>${details}</pre>` })
        }
      } catch {}
    }

    // Mark request approved
    row.status = 'approved'
    row.comments = comments
    await row.save()
    res.json({ ok: true, request: row, allocation: updatedAlloc })
  } catch (e) {
    res.status(500).json({ error: 'Approval failed', details: e.message })
  }
})
