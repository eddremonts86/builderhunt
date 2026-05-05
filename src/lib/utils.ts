import { randomBytes } from 'crypto'

export function randomId(): string {
  return randomBytes(12).toString('hex')
}
