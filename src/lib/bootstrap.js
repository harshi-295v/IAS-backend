import { Faculty } from '../models/Faculty.js'
import { hashPassword } from './hash.js'

export async function bootstrapAdmin() {
  const email = process.env.ADMIN_EMAIL
  const password = process.env.ADMIN_PASSWORD
  const name = process.env.ADMIN_NAME || 'Admin'
  if (!email || !password) return
  // If an admin exists, update it with provided env credentials; else create
  let admin = await Faculty.findOne({ role: 'admin' })
  const passwordHash = await hashPassword(password)
  if (admin) {
    admin.email = email
    admin.name = name
    admin.passwordHash = passwordHash
    admin.department = 'ADMIN'
    admin.designation = 'ADMIN'
    await admin.save()
    console.log(`Updated admin credentials: ${email}`)
  } else {
    await Faculty.create({ name, email, passwordHash, department: 'ADMIN', designation: 'ADMIN', role: 'admin' })
    console.log(`Bootstrapped admin: ${email}`)
  }
}
