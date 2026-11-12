// Minimal database abstraction used by the sample banking service (synthetic code).
export interface Db {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<void>;
}
