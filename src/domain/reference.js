import { randomInt } from 'node:crypto';

// Booking references are the only handle for viewing/cancelling — a bearer
// capability, so they must be unguessable: crypto-random, 8 chars over a
// 31-symbol alphabet ≈ 8.5 × 10^11 combinations. No 0/O/1/I/L — these get
// read out loud and typed back in.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LENGTH = 8;

export function newReference() {
  let out = '';
  for (let i = 0; i < LENGTH; i += 1) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}
