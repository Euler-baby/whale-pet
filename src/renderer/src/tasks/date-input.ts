/** datetime-local 使用本地时区，避免 UTC 转换使编辑后的时间偏移。 */
export function datetimeLocalToTimestamp(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (match === null) return null
  const [year, month, day, hours, minutes] = match.slice(1).map(Number)
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hours === undefined ||
    minutes === undefined
  )
    return null
  const date = new Date(year, month - 1, day, hours, minutes, 0, 0)
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hours &&
    date.getMinutes() === minutes
    ? date.getTime()
    : null
}

export function timestampToDatetimeLocal(value: number | null): string {
  if (value === null) return ''
  const date = new Date(value)
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
