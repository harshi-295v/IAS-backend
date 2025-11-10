import express from 'express'
import { Faculty } from '../models/Faculty.js'
import { hashPassword, comparePassword } from '../lib/hash.js'
import { signJwt } from '../lib/jwt.js'

const router = express.Router()

router.post('/register', async (_req, res) => {
  return res.status(403).json({ error: 'Registration is disabled' })
})

router.post('/login', async (req, res) => {
  try {
    const { email, loginId, password, role } = req.body
    let user
    if (role === 'admin') {
      user = await Faculty.findOne({ role: 'admin' })
    } else {
      // Faculty must login with assigned loginId only
      if (!loginId) return res.status(401).json({ error: 'Invalid credentials' })
      user = await Faculty.findOne({ loginId })
      if (!user || user.role !== 'faculty') return res.status(401).json({ error: 'Invalid credentials' })
      if (!user.credentialGeneratedAt) return res.status(401).json({ error: 'Invalid credentials' })
    }
    if (!user || !user.passwordHash) return res.status(401).json({ error: 'Invalid credentials' })
    // If a role is provided, enforce it
    if (role && user.role !== role) return res.status(401).json({ error: 'Invalid credentials' })
    // For admin login, also require the provided email (ID) to match the configured admin email
    if (role === 'admin') {
      const adminEmail = process.env.ADMIN_EMAIL
      if (!adminEmail || email !== adminEmail) return res.status(401).json({ error: 'Invalid credentials' })
    }
    const ok = await comparePassword(password, user.passwordHash)
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' })
    const token = signJwt({ id: user._id, role: user.role, email: user.email, name: user.name })
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role } })
  } catch (e) {
    res.status(500).json({ error: 'Login failed', details: e.message })
  }
})

export default router
