import nodemailer from 'nodemailer'

let cachedTransport

export async function getTransport() {
  if (cachedTransport) return cachedTransport
  const host = process.env.SMTP_HOST
  const port = Number(process.env.SMTP_PORT || 587)
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465

  if (!host || !user || !pass) {
    // Create Ethereal test account if SMTP not configured
    const testAcc = await nodemailer.createTestAccount()
    cachedTransport = nodemailer.createTransport({
      pool: true,
      maxConnections: Number(process.env.SMTP_MAX_CONN || 1),
      maxMessages: Number(process.env.SMTP_MAX_MSG || 100),
      rateDelta: Number(process.env.SMTP_RATE_DELTA || 1000),
      rateLimit: Number(process.env.SMTP_RATE_LIMIT || 5),
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: { user: testAcc.user, pass: testAcc.pass },
    })
  } else {
    cachedTransport = nodemailer.createTransport({
      pool: true,
      maxConnections: Number(process.env.SMTP_MAX_CONN || 1),
      maxMessages: Number(process.env.SMTP_MAX_MSG || 100),
      rateDelta: Number(process.env.SMTP_RATE_DELTA || 1000),
      rateLimit: Number(process.env.SMTP_RATE_LIMIT || 5),
      host,
      port,
      secure,
      auth: { user, pass },
    })
  }
  return cachedTransport
}

export async function sendMail({ to, subject, html, text }) {
  const from = process.env.FROM_EMAIL || process.env.SMTP_USER || 'Invigilator System <no-reply@example.com>'
  const transporter = await getTransport()
  const info = await transporter.sendMail({ from, to, subject, html, text })
  const previewUrl = nodemailer.getTestMessageUrl(info)
  return { messageId: info.messageId, previewUrl }
}
