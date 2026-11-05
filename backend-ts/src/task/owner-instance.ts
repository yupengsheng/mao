import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

/** 进程级租约持有者标识；同一进程内所有 Session 共用。 */
export function createOwnerInstance(): string {
  return `${hostname()}:${process.pid}:${randomUUID()}`;
}
