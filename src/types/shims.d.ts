declare module 'fs' {
  const fs: any;
  export default fs;
}

declare module 'path' {
  const path: any;
  export default path;
}

declare module 'child_process' {
  export const execFileSync: (...args: any[]) => any;
}

declare const process: any;
declare const require: any;
declare const module: any;
