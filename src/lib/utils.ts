import { randomBytes } from 'crypto'

export function randomId(): string {
  return randomBytes(12).toString('hex')
}

export function randomToken(bytes: number = 32): string {
  return randomBytes(bytes).toString('hex')
}
