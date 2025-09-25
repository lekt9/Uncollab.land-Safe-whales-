declare module 'better-sqlite3' {
  interface DatabaseOptions {
    readonly?: boolean;
    fileMustExist?: boolean;
  }
  class Database {
    constructor(path: string, options?: DatabaseOptions);
    pragma(pragma: string): void;
    exec(sql: string): void;
  }
  export default Database;
}

declare module 'drizzle-orm/better-sqlite3' {
  import type Database from 'better-sqlite3';
  export type BetterSQLite3Database = any;
  export function drizzle(db: Database, config?: any): BetterSQLite3Database;
}

declare module 'drizzle-orm/sqlite-core' {
  export function sqliteTable(...args: any[]): any;
  export function integer(column: string, config?: any): any;
  export function text(column: string, config?: any): any;
  export function real(column: string, config?: any): any;
}

declare module 'drizzle-orm' {
  export const sql: any;
  export const eq: any;
  export const and: any;
  export const isNotNull: any;
}
