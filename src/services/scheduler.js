import dayjs from 'dayjs'
import { Exam } from '../models/Exam.js'
import { Faculty } from '../models/Faculty.js'
import { FacultyRoster } from '../models/FacultyRoster.js'
import { Allocation } from '../models/Allocation.js'
import { Settings } from '../models/Settings.js'

function isAvailableOnDateAndSlot(fac, date, slot) {
  if (!fac.availability || fac.availability.length === 0) return true // assume available if not provided
  const d = dayjs(date)
  const dow = d.day()
  for (const a of fac.availability) {
    if (a.date && a.date === date && a.slots?.includes(slot)) return true
    if (typeof a.dayOfWeek === 'number' && a.dayOfWeek === dow && a.slots?.includes(slot)) return true
  }
  return false
}

function weightForFaculty(fac, constraints) {
  const deptW = Number(constraints?.departmentWeighting?.get?.(fac.department) ?? constraints?.departmentWeighting?.[fac.department] ?? 1)
  const desigW = Number(constraints?.designationWeighting?.get?.(fac.designation) ?? constraints?.designationWeighting?.[fac.designation] ?? 1)
  const loadPenalty = 1 / (1 + fac.currentLoad)
  return deptW * desigW * loadPenalty
}

async function loadConstraints() {
  const doc = await Settings.findOne({ key: 'global' })
  return doc?.constraints || { maxHoursPerDay: 0, noSameDayRepeat: true }
}

export async function generateScheduleForDate(date) {
  const constraints = await loadConstraints()
  const exams = await Exam.find({ date }).lean()
  // Load roster and map to Faculty accounts by email; only accounts with roster rows participate
  const roster = await FacultyRoster.find({}).lean()
  const emails = roster.map(r => r.email).filter(Boolean)
  const accounts = emails.length ? await Faculty.find({ email: { $in: emails } }).lean() : []
  const rosterByEmail = new Map(roster.map(r => [String(r.email).toLowerCase(), r]))
  const faculties = accounts.map(acc => {
    const r = rosterByEmail.get(String(acc.email).toLowerCase()) || {}
    return {
      ...acc,
      availability: r.availability || acc.availability || [],
      department: r.department || acc.department,
      designation: r.designation || acc.designation,
      maxHoursPerDay: typeof r.maxHoursPerDay === 'number' ? r.maxHoursPerDay : acc.maxHoursPerDay,
      weeklyCap: typeof r.weeklyCap === 'number' ? r.weeklyCap : acc.weeklyCap,
    }
  })

  // Load existing allocations for the day and compute per-faculty previous counts
  const existingForDay = await Allocation.find({ date }).lean()
  const prevCountForFaculty = new Map() // facultyId -> count (existing before regenerate)
  for (const a of existingForDay) {
    const fid = String(a.invigilatorId)
    prevCountForFaculty.set(fid, (prevCountForFaculty.get(fid) || 0) + 1)
  }

  // Replace-mode: remove previous allocations for this date to avoid accumulation
  if (existingForDay.length) {
    await Allocation.deleteMany({ date })
  }
  const takenBySlot = new Map() // slot -> Set(invigilatorId)
  const takenByDay = new Set(existingForDay.map(a => String(a.invigilatorId)))
  for (const a of existingForDay) {
    const s = a.slot
    if (!takenBySlot.has(s)) takenBySlot.set(s, new Set())
    takenBySlot.get(s).add(String(a.invigilatorId))
  }

  // Local mutable daily counts and current loads
  const dailyCounts = new Map() // facultyId -> number for this date
  const currentLoads = new Map() // facultyId -> currentLoad (baseline prior to this generation)
  faculties.forEach(f => {
    const id = String(f._id)
    currentLoads.set(id, Number(f.currentLoad || 0))
    const d = (f.dailyLoad && (f.dailyLoad.get ? f.dailyLoad.get(date) : f.dailyLoad[date])) || 0
    dailyCounts.set(id, Number(d))
  })

  // Precompute base weights per faculty
  const baseWeight = new Map()
  faculties.forEach(f => baseWeight.set(String(f._id), weightForFaculty(f, constraints)))

  const allocationsToInsert = []

  for (const exam of exams) {
    const slot = exam.slot
    if (!takenBySlot.has(slot)) takenBySlot.set(slot, new Set())
    const takenSlotSet = takenBySlot.get(slot)
    for (const room of exam.rooms) {
      const needed = Math.max(1, Number(room.neededInvigilators || 1))
      for (let i = 0; i < needed; i++) {
        // Build and filter candidates in-memory
        let best = null
        let bestScore = -Infinity
        for (const f of faculties) {
          const id = String(f._id)
          // Capacity constraints
          const dayCount = dailyCounts.get(id) || 0
          if (constraints.maxHoursPerDay && dayCount >= constraints.maxHoursPerDay) continue
          if (!isAvailableOnDateAndSlot(f, date, slot)) continue
          if (takenSlotSet.has(id)) continue
          if (constraints.noSameDayRepeat && takenByDay.has(id)) continue
          // Score: base weight adjusted by lower dayCount and currentLoad
          const score = (baseWeight.get(id) || 1) * (1 / (1 + (currentLoads.get(id) || 0))) * (1 / (1 + dayCount))
          if (score > bestScore) { bestScore = score; best = f }
        }
        if (!best) {
          // no available candidate; mark pending
          allocationsToInsert.push({ examId: exam._id, date, slot, classroomCode: room.classroomCode, invigilatorId: faculties[0]?._id, status: 'pending' })
          continue
        }
        const chosenId = String(best._id)
        allocationsToInsert.push({ examId: exam._id, date, slot, classroomCode: room.classroomCode, invigilatorId: best._id, status: 'assigned' })
        // Update local state
        takenSlotSet.add(chosenId)
        takenByDay.add(chosenId)
        currentLoads.set(chosenId, (currentLoads.get(chosenId) || 0) + 1)
        dailyCounts.set(chosenId, (dailyCounts.get(chosenId) || 0) + 1)
      }
    }
  }

  // Commit allocations
  if (allocationsToInsert.length) {
    await Allocation.insertMany(allocationsToInsert)
  }

  // Bulk update affected faculties (adjusting for previous allocations removed)
  const bulkOps = []
  for (const f of faculties) {
    const id = String(f._id)
    const newAdds = (currentLoads.get(id) || 0) - Number(f.currentLoad || 0)
    const prev = prevCountForFaculty.get(id) || 0
    const inc = newAdds - prev // net change in currentLoad after replacing the day
    const dayCount = dailyCounts.get(id) || 0
    if (inc > 0 || dayCount > ((f.dailyLoad && (f.dailyLoad.get ? f.dailyLoad.get(date) : f.dailyLoad[date])) || 0)) {
      bulkOps.push({
        updateOne: {
          filter: { _id: id },
          update: {
            ...(inc !== 0 ? { $inc: { currentLoad: inc } } : {}),
            $set: { [`dailyLoad.${date}`]: dayCount },
          }
        }
      })
    }
  }
  if (bulkOps.length) await Faculty.bulkWrite(bulkOps)

  const created = await Allocation.find({ date }).populate('invigilatorId', 'name email department designation').lean()
  return created
}

export async function getScheduleForDate(date) {
  const rows = await Allocation.find({ date }).populate('invigilatorId', 'name email department designation').lean()
  return rows
}

export async function reassignAllocation(allocationId, toFacultyId) {
  const alloc = await Allocation.findById(allocationId)
  if (!alloc) throw new Error('Allocation not found')
  const fac = await Faculty.findById(toFacultyId)
  if (!fac) throw new Error('Faculty not found')
  // Enforce single-room-per-slot: ensure faculty is not already assigned in same date+slot
  const conflict = await Allocation.findOne({
    _id: { $ne: alloc._id },
    date: alloc.date,
    slot: alloc.slot,
    invigilatorId: fac._id,
    status: { $in: ['assigned','pending'] },
  }).lean()
  if (conflict) throw new Error('Faculty already assigned in this slot')
  alloc.invigilatorId = fac._id
  alloc.status = 'assigned'
  await alloc.save()
  return alloc
}
