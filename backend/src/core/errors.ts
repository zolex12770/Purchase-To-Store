/**
 * Error taxonomy (SRS §21 centralised error handling, §37 of the build brief).
 *
 * Users see a human-readable message and a stable machine code.
 * Stack traces and driver internals are logged server-side and never serialised
 * to the client.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTHENTICATION_ERROR'
  | 'AUTHORIZATION_ERROR'
  | 'PASSWORD_CHANGE_REQUIRED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'BUSINESS_RULE_VIOLATION'
  | 'INTEGRATION_ERROR'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'SERVER_ERROR';

export interface FieldIssue {
  field: string;
  message: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly issues?: FieldIssue[];
  readonly details?: Record<string, unknown>;
  /** `true` for errors we raised deliberately; `false` marks an unexpected crash. */
  readonly expected: boolean;

  constructor(
    code: ErrorCode,
    status: number,
    message: string,
    options: { issues?: FieldIssue[]; details?: Record<string, unknown>; expected?: boolean } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.issues = options.issues;
    this.details = options.details;
    this.expected = options.expected ?? true;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const ValidationError = (message: string, issues?: FieldIssue[]) =>
  new AppError('VALIDATION_ERROR', 422, message, { issues });

export const AuthenticationError = (message = 'Authentication required.') =>
  new AppError('AUTHENTICATION_ERROR', 401, message);

export const AuthorizationError = (message = 'You do not have permission to perform this action.') =>
  new AppError('AUTHORIZATION_ERROR', 403, message);

/**
 * The account must replace its password before anything but the auth routes will
 * answer. A code of its own, so the client can show the change-password screen
 * instead of treating it as a missing permission.
 */
export const PasswordChangeRequiredError = (message = 'You must change your password before you can continue.') =>
  new AppError('PASSWORD_CHANGE_REQUIRED', 403, message);

export const NotFoundError = (what = 'Record') =>
  new AppError('NOT_FOUND', 404, `${what} was not found.`);

export const ConflictError = (message: string, details?: Record<string, unknown>) =>
  new AppError('CONFLICT', 409, message, { details });

/** A request that is well-formed but violates a domain rule (quantity, status, workflow). */
export const BusinessRuleError = (message: string, details?: Record<string, unknown>) =>
  new AppError('BUSINESS_RULE_VIOLATION', 422, message, { details });

export const IntegrationError = (message: string, details?: Record<string, unknown>) =>
  new AppError('INTEGRATION_ERROR', 502, message, { details });

export const ServerError = (message = 'An unexpected error occurred.') =>
  new AppError('SERVER_ERROR', 500, message, { expected: false });

/**
 * Translates a PostgreSQL driver error into a user-facing AppError.
 * Constraint names are mapped to plain-English messages so the last line of
 * database defence still produces a sentence a purchase clerk can act on.
 */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  uq_users_employee_id: 'That Employee ID is already registered.',
  uq_suppliers_code: 'That supplier code is already in use.',
  uq_suppliers_name: 'A supplier with that name already exists.',
  uq_items_code: 'That Item Code is already in use.',
  uq_lookups_category_code: 'That code already exists in this master.',
  uq_lookups_category_name: 'That name already exists in this master.',
  uq_indent_no: 'That indent number is already in use.',
  uq_po_no: 'That PO number is already in use.',
  uq_grn_no: 'That GRN number is already in use.',
  uq_po_source: 'This purchase order line already draws from that indent line.',
  chk_indent_qty: 'Indent quantity must be greater than zero.',
  chk_po_qty: 'PO quantity must be greater than zero.',
  chk_grn_qty: 'GRN quantity must be greater than zero.',
  chk_po_discount: 'Discount must be between 0 and 100 percent.',
  chk_po_rate: 'Rate cannot be negative.',
  chk_po_source_qty: 'Consumed quantity must be greater than zero.',
  chk_indent_rejection_reason: 'A rejection reason is required.',
  chk_po_close_reason: 'A reason is required to short-close a purchase order.',
  chk_grn_cancel_reason: 'A reason is required to cancel a GRN.',
};

interface PgErrorShape {
  code?: string;
  constraint?: string;
  detail?: string;
  table?: string;
  column?: string;
  message?: string;
}

export function translateDatabaseError(err: unknown): AppError | null {
  const e = err as PgErrorShape;
  const pgCode = e?.code;
  // PGlite surfaces the SQLSTATE inside the message for some paths; fall back to text.
  const text = typeof e?.message === 'string' ? e.message : '';
  const constraint =
    e?.constraint ??
    /(?:constraint|index)\s+"([^"]+)"/i.exec(text)?.[1] ??
    /violates check constraint "([^"]+)"/i.exec(text)?.[1];

  const friendly = constraint ? CONSTRAINT_MESSAGES[constraint] : undefined;

  const isUnique = pgCode === '23505' || /duplicate key value|unique constraint/i.test(text);
  const isCheck = pgCode === '23514' || /check constraint/i.test(text);
  const isFk = pgCode === '23503' || /foreign key constraint/i.test(text);
  const isNotNull = pgCode === '23502' || /null value in column/i.test(text);

  if (isUnique) {
    return ConflictError(friendly ?? 'A record with these details already exists.', { constraint });
  }
  if (isCheck) {
    return BusinessRuleError(friendly ?? 'The submitted values violate a data rule.', { constraint });
  }
  if (isFk) {
    return ConflictError(
      friendly ??
        'This record is referenced by other data, or refers to a record that does not exist.',
      { constraint },
    );
  }
  if (isNotNull) {
    const col = e?.column ?? /null value in column "([^"]+)"/i.exec(text)?.[1];
    return ValidationError('A required field is missing.', col ? [{ field: col, message: 'Required.' }] : undefined);
  }
  return null;
}
