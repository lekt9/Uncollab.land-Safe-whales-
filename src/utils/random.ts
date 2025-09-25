import { config } from '../config';

export function getRandomVerificationAmount(): number {
  const min = config.minTokenCode;
  const max = config.maxTokenCode;
  return Math.round((Math.random() * (max - min) + min) * 1e9) / 1e9;
}
