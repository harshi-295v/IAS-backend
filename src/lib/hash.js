import bcrypt from 'bcryptjs'

const ROUNDS = 10

export async function hashPassword(password) {
  const salt = await bcrypt.genSalt(ROUNDS)
  return bcrypt.hash(password, salt)
}

export async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash)
}
