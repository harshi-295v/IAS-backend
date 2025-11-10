import { Settings } from '../models/Settings.js'

// Clear only the "fresh upload" flags so the UI requires file imports again,
// without deleting existing collections. This preserves data for past schedules.
export async function clearUploadFlags() {
  await Settings.updateOne(
    { key: 'uploadStatus' },
    { $set: { key: 'uploadStatus' }, $unset: { facultyAt: 1, classroomsAt: 1, examsAt: 1 } },
    { upsert: true }
  )
}
