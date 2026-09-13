/**
 * Time utilities — all business dates are computed in Asia/Kolkata (IST).
 * Timestamps are stored in UTC; the server clock is authoritative for
 * financial timestamps; the device clock is never trusted (spec §1.3, §28.5).
 */
export const IST_TIMEZONE = 'Asia/Kolkata';
const WEEKDAY_INDEX = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
};
const istFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
});
/** Current IST calendar/time parts for a given instant (defaults to now). */
export function istParts(instant = new Date()) {
    const parts = istFormatter.formatToParts(instant);
    const get = (type) => parts.find((part) => part.type === type)?.value ?? '';
    const weekdayName = get('weekday');
    return {
        year: Number(get('year')),
        month: Number(get('month')),
        day: Number(get('day')),
        hour: Number(get('hour')) % 24,
        minute: Number(get('minute')),
        second: Number(get('second')),
        weekday: WEEKDAY_INDEX[weekdayName] ?? 0,
    };
}
function pad(value, width = 2) {
    return String(value).padStart(width, '0');
}
/** IST business date (YYYY-MM-DD) for a given instant. */
export function istBusinessDate(instant = new Date()) {
    const p = istParts(instant);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}
/** Current IST date-time string (YYYY-MM-DD HH:mm:ss). */
export function istDateTimeString(instant = new Date()) {
    const p = istParts(instant);
    return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}
/** Whether the current IST time is at or past the given hour (deadline check). */
export function isPastIstDeadline(hour, instant = new Date()) {
    const p = istParts(instant);
    return p.hour >= hour;
}
/** Sunday check on a YYYY-MM-DD date string (holidays come from the DB calendar). */
export function isSunday(dateString) {
    return dayOfWeek(dateString) === 0;
}
export function dayOfWeek(dateString) {
    const date = parseDateString(dateString);
    return date.getUTCDay();
}
function parseDateString(dateString) {
    return new Date(`${dateString}T00:00:00.000Z`);
}
function toDateString(date) {
    return date.toISOString().slice(0, 10);
}
export function isValidDateString(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parseDateString(value).getTime());
}
export function addDays(dateString, days) {
    const date = parseDateString(dateString);
    date.setUTCDate(date.getUTCDate() + days);
    return toDateString(date);
}
export function addMonths(dateString, months) {
    const date = parseDateString(dateString);
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + months);
    const lastDayOfMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDayOfMonth));
    return toDateString(date);
}
export function daysBetween(from, to) {
    return Math.round((parseDateString(to).getTime() - parseDateString(from).getTime()) / 86_400_000);
}
/** Financial year (1 April – 31 March) label for an IST date, e.g. 2026-27. */
export function financialYearLabel(dateString) {
    const date = parseDateString(dateString);
    const year = date.getUTCFullYear();
    const startYear = date.getUTCMonth() >= 3 ? year : year - 1; // April = month 3
    return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}
/** Financial-year start (YYYY-04-01) and end (YYYY+1-03-31) for an IST date. */
export function financialYearRange(dateString) {
    const date = parseDateString(dateString);
    const year = date.getUTCFullYear();
    const startYear = date.getUTCMonth() >= 3 ? year : year - 1;
    return { start: `${startYear}-04-01`, end: `${startYear + 1}-03-31` };
}
/** DD/MM/YYYY formatting for all customer/staff-facing output (spec §3). */
export function formatDDMMYYYY(dateString) {
    const [year, month, day] = dateString.split('-');
    if (!year || !month || !day)
        return dateString;
    return `${day}/${month}/${year}`;
}
/** Whether the dispute window (3 months from transaction) is still open (spec §19.1). */
export function withinDisputeWindow(transactionDate, referenceDate = istBusinessDate()) {
    const windowEnd = addMonths(transactionDate, 3);
    return daysBetween(windowEnd, referenceDate) >= 0;
}
