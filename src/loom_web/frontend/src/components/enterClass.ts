/**
 * Return `baseClass` with " loom-enter" appended when `isNew` is true.
 *
 * Use this on card / row / node root elements so that items newly added
 * via the WS store update animate in on mount.
 */
export function enterClass(baseClass: string, isNew: boolean | undefined): string {
  return isNew ? `${baseClass} loom-enter` : baseClass;
}
