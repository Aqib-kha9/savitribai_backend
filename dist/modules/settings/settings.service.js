import { query, transaction } from '../../database/client.js';
import { appendAuditEvent, } from '../../audit/audit-writer.js';
import { istBusinessDate, addDays } from '../../core/time.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors.js';
// ---------------------------------------------------------------------------
// Local audit helpers (same transaction as the mutation — spec §6.3)
// ---------------------------------------------------------------------------
function audit(client, input) {
    const event = {
        actorStaffId: input.actorStaffId ?? null,
        actorRole: input.actorRole ?? null,
        actorStaffCode: input.actorStaffCode ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        source: input.source,
        requestId: input.requestId ?? null,
        businessDate: input.businessDate ?? istBusinessDate(),
    };
    if (input.metadata !== undefined)
        event.metadata = input.metadata;
    return appendAuditEvent(client, event);
}
function actorAuditBase(actor) {
    return {
        actorStaffId: actor.staffId,
        actorRole: actor.role,
        actorStaffCode: actor.staffCode,
        source: actor.source,
        requestId: null,
    };
}
function isUniqueViolation(error) {
    return (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505');
}
// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------
function toOrganisationView(row) {
    return {
        id: row.id,
        legalName: row.legal_name,
        displayName: row.display_name,
        registrationNumber: row.registration_number,
        legalAddress: row.legal_address,
        phone: row.phone,
        email: row.email,
        timezone: row.timezone,
        currency: row.currency,
        locale: row.locale,
        financialYearStartMonth: row.financial_year_start_month,
        workingDays: row.working_days,
        operatingHours: row.operating_hours,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}
function toBranchView(row) {
    return {
        id: row.id,
        organisationId: row.organisation_id,
        code: row.code,
        name: row.name,
        address: row.address,
        phone: row.phone,
        isActive: row.is_active,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}
function toHolidayView(row) {
    return {
        id: row.id,
        holidayDate: row.holiday_date,
        occasion: row.occasion,
        calendarYear: row.calendar_year,
        isGovernment: row.is_government,
        createdAt: row.created_at.toISOString(),
    };
}
function toSettingView(row) {
    return {
        key: row.key,
        value: row.value,
        category: row.category,
        description: row.description,
        updatedBy: row.updated_by,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}
function toSettingHistoryView(row) {
    return {
        id: row.id,
        settingKey: row.setting_key,
        oldValue: row.old_value,
        newValue: row.new_value,
        changedBy: row.changed_by,
        changedByName: row.changed_by_name,
        reason: row.reason,
        createdAt: row.created_at.toISOString(),
    };
}
// ---------------------------------------------------------------------------
// Organisation (single row)
// ---------------------------------------------------------------------------
async function selectOrganisation(client) {
    const result = await client.query(`SELECT id, legal_name, display_name, registration_number, legal_address,
            phone, email, timezone, currency, locale, financial_year_start_month,
            working_days, operating_hours, created_at, updated_at
       FROM organisation
      ORDER BY created_at ASC
      LIMIT 1`);
    return result.rows[0] ?? null;
}
/**
 * GET /organisation — the single organisation row (spec §22.2 organisation
 * details). Read surface; settings.read.
 */
export async function getOrganisation(_actor, _meta) {
    const result = await query(`SELECT id, legal_name, display_name, registration_number, legal_address,
            phone, email, timezone, currency, locale, financial_year_start_month,
            working_days, operating_hours, created_at, updated_at
       FROM organisation
      ORDER BY created_at ASC
      LIMIT 1`);
    const row = result.rows[0];
    if (!row)
        throw new NotFoundError('Organisation not found');
    return toOrganisationView(row);
}
/**
 * PATCH /organisation — updates the single organisation row. Every change is
 * audited (settings.organisation.updated) with the touched fields.
 */
export async function updateOrganisation(actor, input, meta) {
    const updated = await transaction(async (client) => {
        const existing = await selectOrganisation(client);
        if (!existing)
            throw new NotFoundError('Organisation not found');
        const setClauses = [];
        const params = [];
        const push = (column, value) => {
            params.push(value);
            setClauses.push(`${column} = $${params.length}`);
        };
        if (input.legalName !== undefined)
            push('legal_name', input.legalName);
        if (input.displayName !== undefined)
            push('display_name', input.displayName);
        if (input.registrationNumber !== undefined)
            push('registration_number', input.registrationNumber);
        if (input.legalAddress !== undefined)
            push('legal_address', input.legalAddress);
        if (input.phone !== undefined)
            push('phone', input.phone);
        if (input.email !== undefined)
            push('email', input.email);
        if (input.timezone !== undefined)
            push('timezone', input.timezone);
        if (input.currency !== undefined)
            push('currency', input.currency);
        if (input.locale !== undefined)
            push('locale', input.locale);
        if (input.financialYearStartMonth !== undefined)
            push('financial_year_start_month', input.financialYearStartMonth);
        if (input.workingDays !== undefined)
            push('working_days', input.workingDays);
        if (input.operatingHours !== undefined)
            push('operating_hours', input.operatingHours);
        setClauses.push('updated_at = now()');
        const result = await client.query(`UPDATE organisation
          SET ${setClauses.join(', ')}
        WHERE id = $${params.length + 1}
       RETURNING id, legal_name, display_name, registration_number, legal_address,
                 phone, email, timezone, currency, locale, financial_year_start_month,
                 working_days, operating_hours, created_at, updated_at`, [...params, existing.id]);
        const row = result.rows[0];
        if (!row)
            throw new NotFoundError('Organisation not found');
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: 'settings.organisation.updated',
            entityType: 'organisation',
            entityId: row.id,
            metadata: { updatedFields: input },
        });
        return row;
    });
    return toOrganisationView(updated);
}
// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------
/**
 * GET /branches — paginated branch registry with an optional active filter.
 */
export async function listBranches(_actor, input, _meta) {
    const clauses = [];
    const params = [];
    const push = (clause, value) => {
        params.push(value);
        clauses.push(`${clause} $${params.length}`);
    };
    if (input.isActive !== undefined) {
        push('is_active =', input.isActive === 'true');
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join('\n  AND ')}` : '';
    const { page, pageSize } = input;
    const offset = (page - 1) * pageSize;
    const result = await query(`SELECT id, organisation_id, code, name, address, phone, is_active,
            created_at, updated_at,
            COUNT(*) OVER() AS total_count
       FROM branch
       ${whereSql}
      ORDER BY code ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, pageSize, offset]);
    const rows = result.rows;
    const items = rows.map((row) => toBranchView(row));
    const total = rows.length > 0 ? Number(rows[0]?.total_count ?? 0) : 0;
    return { items, total, page, pageSize };
}
/**
 * POST /branches — creates a branch under the single organisation. Duplicate
 * branch codes surface as a 409 (branch.code is UNIQUE).
 */
export async function createBranch(actor, input, meta) {
    const created = await transaction(async (client) => {
        const org = await selectOrganisation(client);
        if (!org)
            throw new NotFoundError('Organisation not found');
        const result = await client.query(`INSERT INTO branch (organisation_id, code, name, address, phone, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, organisation_id, code, name, address, phone, is_active,
                 created_at, updated_at`, [org.id, input.code, input.name, input.address, input.phone ?? null, input.isActive]);
        const row = result.rows[0];
        if (!row)
            throw new BadRequestError('Branch was not created');
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: 'settings.branch.created',
            entityType: 'branch',
            entityId: row.id,
            metadata: { code: row.code, name: row.name },
        });
        return row;
    }).catch((error) => {
        if (isUniqueViolation(error)) {
            throw new ConflictError('A branch with this code already exists', 'BRANCH_CODE_CONFLICT');
        }
        throw error;
    });
    return toBranchView(created);
}
/**
 * PATCH /branches/:id — edits branch details or active flag. Audited with the
 * changed fields.
 */
export async function updateBranch(actor, branchId, input, meta) {
    const updated = await transaction(async (client) => {
        const existing = await client.query(`SELECT id FROM branch WHERE id = $1`, [branchId]);
        if (existing.rows.length === 0)
            throw new NotFoundError('Branch not found');
        const setClauses = [];
        const params = [];
        const push = (column, value) => {
            params.push(value);
            setClauses.push(`${column} = $${params.length}`);
        };
        if (input.code !== undefined)
            push('code', input.code);
        if (input.name !== undefined)
            push('name', input.name);
        if (input.address !== undefined)
            push('address', input.address);
        if (input.phone !== undefined)
            push('phone', input.phone);
        if (input.isActive !== undefined)
            push('is_active', input.isActive);
        setClauses.push('updated_at = now()');
        const result = await client.query(`UPDATE branch
          SET ${setClauses.join(', ')}
        WHERE id = $${params.length + 1}
       RETURNING id, organisation_id, code, name, address, phone, is_active,
                 created_at, updated_at`, [...params, branchId]);
        const row = result.rows[0];
        if (!row)
            throw new NotFoundError('Branch not found');
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: 'settings.branch.updated',
            entityType: 'branch',
            entityId: row.id,
            metadata: { updatedFields: input },
        });
        return row;
    }).catch((error) => {
        if (isUniqueViolation(error)) {
            throw new ConflictError('A branch with this code already exists', 'BRANCH_CODE_CONFLICT');
        }
        throw error;
    });
    return toBranchView(updated);
}
// ---------------------------------------------------------------------------
// Holiday calendar
// ---------------------------------------------------------------------------
/**
 * GET /holidays — paginated holiday calendar with an optional year filter.
 */
export async function listHolidays(_actor, input, _meta) {
    const clauses = [];
    const params = [];
    const push = (clause, value) => {
        params.push(value);
        clauses.push(`${clause} $${params.length}`);
    };
    if (input.year !== undefined) {
        push('calendar_year =', input.year);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join('\n  AND ')}` : '';
    const { page, pageSize } = input;
    const offset = (page - 1) * pageSize;
    const result = await query(`SELECT id, holiday_date, occasion, calendar_year, is_government, created_at,
            COUNT(*) OVER() AS total_count
       FROM holiday_calendar
       ${whereSql}
      ORDER BY holiday_date ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, pageSize, offset]);
    const rows = result.rows;
    const items = rows.map((row) => toHolidayView(row));
    const total = rows.length > 0 ? Number(rows[0]?.total_count ?? 0) : 0;
    return { items, total, page, pageSize };
}
/**
 * POST /holidays — adds a calendar holiday. calendar_year derives from
 * holidayDate unless explicitly supplied. Duplicate dates surface as a 409
 * (holiday_calendar.holiday_date is UNIQUE).
 */
export async function createHoliday(actor, input, meta) {
    const calendarYear = input.calendarYear ?? Number(input.holidayDate.slice(0, 4));
    const created = await transaction(async (client) => {
        const result = await client.query(`INSERT INTO holiday_calendar (holiday_date, occasion, calendar_year, is_government)
       VALUES ($1, $2, $3, $4)
       RETURNING id, holiday_date, occasion, calendar_year, is_government, created_at`, [input.holidayDate, input.occasion, calendarYear, input.isGovernment]);
        const row = result.rows[0];
        if (!row)
            throw new BadRequestError('Holiday was not created');
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: 'settings.holiday.created',
            entityType: 'holiday_calendar',
            entityId: row.id,
            metadata: { holidayDate: row.holiday_date, occasion: row.occasion },
        });
        return row;
    }).catch((error) => {
        if (isUniqueViolation(error)) {
            throw new ConflictError('A holiday already exists on this date', 'HOLIDAY_DATE_CONFLICT');
        }
        throw error;
    });
    return toHolidayView(created);
}
/**
 * DELETE /holidays/:id — removes a calendar holiday. Audited.
 */
export async function deleteHoliday(actor, holidayId, meta) {
    await transaction(async (client) => {
        const existing = await client.query(`SELECT id FROM holiday_calendar WHERE id = $1`, [holidayId]);
        if (existing.rows.length === 0)
            throw new NotFoundError('Holiday not found');
        await client.query(`DELETE FROM holiday_calendar WHERE id = $1`, [holidayId]);
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: 'settings.holiday.deleted',
            entityType: 'holiday_calendar',
            entityId: holidayId,
            metadata: { id: holidayId },
        });
    });
    return { success: true, id: holidayId };
}
// ---------------------------------------------------------------------------
// App settings (operational preferences)
// ---------------------------------------------------------------------------
/**
 * GET /settings — current app_setting rows, optionally filtered by category.
 * JSONB values arrive already parsed.
 */
export async function listSettings(_actor, input, _meta) {
    const clauses = [];
    const params = [];
    const push = (clause, value) => {
        params.push(value);
        clauses.push(`${clause} $${params.length}`);
    };
    if (input.category !== undefined) {
        push('category =', input.category);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join('\n  AND ')}` : '';
    const result = await query(`SELECT key, value, category, description, updated_by, created_at, updated_at,
            COUNT(*) OVER() AS total_count
       FROM app_setting
       ${whereSql}
      ORDER BY key ASC`, params);
    const rows = result.rows;
    const items = rows.map((row) => toSettingView(row));
    const total = rows.length > 0 ? Number(rows[0]?.total_count ?? 0) : 0;
    return { items, total };
}
/**
 * PATCH /settings — bulk update of existing app_setting keys. Each change
 * stores the JSONB value, appends a setting_change_history entry, and writes a
 * settings.setting.changed audit event in the same transaction (§22.2). The old
 * value is captured just before the update so the history is accurate even for
 * repeated requests touching the same key.
 */
export async function updateSettings(actor, input, meta) {
    return transaction(async (client) => {
        const changes = [];
        const historyIds = [];
        for (const change of input.changes) {
            const current = await client.query(`SELECT value FROM app_setting WHERE key = $1`, [change.key]);
            if (current.rows.length === 0) {
                throw new BadRequestError(`Unknown setting key: ${change.key}`, 'UNKNOWN_SETTING_KEY');
            }
            const oldValue = current.rows[0]?.value ?? null;
            const newValueJson = change.value === undefined ? 'null' : JSON.stringify(change.value);
            const updated = await client.query(`UPDATE app_setting
            SET value = $2::jsonb, updated_by = $3, updated_at = now()
          WHERE key = $1
         RETURNING key, value, updated_at`, [change.key, newValueJson, actor.staffId]);
            const updatedRow = updated.rows[0];
            if (!updatedRow) {
                throw new BadRequestError(`Unknown setting key: ${change.key}`, 'UNKNOWN_SETTING_KEY');
            }
            const oldValueJson = oldValue === null ? null : JSON.stringify(oldValue);
            const history = await client.query(`INSERT INTO setting_change_history (setting_key, old_value, new_value, changed_by, reason)
         VALUES ($1, $2::jsonb, $3::jsonb, $4, $5)
         RETURNING id`, [change.key, oldValueJson, newValueJson, actor.staffId, change.reason ?? null]);
            const historyId = history.rows[0]?.id;
            if (historyId !== undefined)
                historyIds.push(historyId);
            changes.push({ key: change.key, oldValue, newValue: updatedRow.value });
            await audit(client, {
                ...actorAuditBase(actor),
                requestId: meta.requestId ?? null,
                action: 'settings.setting.changed',
                entityType: 'app_setting',
                entityId: change.key,
                metadata: {
                    key: change.key,
                    oldValue,
                    newValue: updatedRow.value,
                    reason: change.reason ?? null,
                },
            });
        }
        return { changes, historyIds };
    });
}
/**
 * GET /settings/history — append-only setting change trail. Optionally filtered
 * by setting key and an inclusive IST day range over created_at. The changing
 * staff member's name comes from a join on staff.
 */
export async function listSettingHistory(_actor, input, _meta) {
    const clauses = [];
    const params = [];
    const push = (clause, value) => {
        params.push(value);
        clauses.push(`${clause} $${params.length}`);
    };
    if (input.settingKey !== undefined) {
        push('h.setting_key =', input.settingKey);
    }
    if (input.from !== undefined) {
        params.push(`${input.from}T00:00:00+05:30`);
        clauses.push(`h.created_at >= $${params.length}::timestamptz`);
    }
    if (input.to !== undefined) {
        params.push(`${addDays(input.to, 1)}T00:00:00+05:30`);
        clauses.push(`h.created_at < $${params.length}::timestamptz`);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join('\n  AND ')}` : '';
    const { page, pageSize } = input;
    const offset = (page - 1) * pageSize;
    const result = await query(`SELECT h.id, h.setting_key, h.old_value, h.new_value, h.changed_by,
            st.full_name AS changed_by_name, h.reason, h.created_at,
            COUNT(*) OVER() AS total_count
       FROM setting_change_history h
       LEFT JOIN staff st ON st.id = h.changed_by
       ${whereSql}
      ORDER BY h.created_at DESC, h.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, pageSize, offset]);
    const rows = result.rows;
    const items = rows.map((row) => toSettingHistoryView(row));
    const total = rows.length > 0 ? Number(rows[0]?.total_count ?? 0) : 0;
    return { items, total, page, pageSize };
}
