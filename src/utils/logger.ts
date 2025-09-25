function timestamp(): string {
  return new Date().toISOString();
}

export function log(...args: unknown[]): void {
  console.log(`[${timestamp()}]`, ...args);
}

export function warn(...args: unknown[]): void {
  console.warn(`[${timestamp()}]`, ...args);
}

export function error(...args: unknown[]): void {
  console.error(`[${timestamp()}]`, ...args);
}

export default {
  log,
  warn,
  error,
};
