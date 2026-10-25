// The package ships no type declarations; only the lock call used by writer-lease.ts is typed.
declare module "fs-native-extensions" {
  /**
   * Non-blocking lock on an open file descriptor: an open-file-description (OFD) lock on Linux,
   * flock on macOS, LockFileEx on Windows. Exclusive unless `shared` is set. Returns false when
   * another holder has the lock and throws on any other error.
   */
  export function tryLock(fd: number, options?: Readonly<{ shared?: boolean }>): boolean;
}
