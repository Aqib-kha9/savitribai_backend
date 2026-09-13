/** Minimal structural type for node-postgres error objects. */
export interface PgErrorLike {
  code?: string | undefined;
  constraint?: string | undefined;
  detail?: string | undefined;
  message: string;
}
