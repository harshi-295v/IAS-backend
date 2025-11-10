import { parse } from 'csv-parse/sync'

export function parseCsv(buffer) {
  const text = buffer.toString('utf-8')
  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true,
  })
  return records
}
