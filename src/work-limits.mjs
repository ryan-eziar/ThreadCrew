// Public unlimited authority is explicit and has no deadline. SQLite retains
// a sortable sentinel in its existing NOT NULL expiry column, not in the API.
export const UNLIMITED_WORK_DB_EXPIRY = '9999-12-31T23:59:59.999Z';
export const workExpired = (work, now) => work?.unlimited !== true && Date.parse(work?.expiresAt) <= now;
export const workUnexpired = (work, now) => work?.unlimited === true || Date.parse(work?.expiresAt) > now;
export const budgetExhausted = budget => budget.limit !== null && budget.remaining <= 0;
