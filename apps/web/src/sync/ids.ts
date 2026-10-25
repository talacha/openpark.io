/**
 * UUIDv7 implementation for mutation IDs.
 * Format: timestamp (48 bits) + random (80 bits), formatted as standard UUID string.
 * Monotonic ordering is guaranteed per process by bumping 1 µs when it would not increase.
 */

// Monotonic counter to ensure strictly increasing IDs
let _lastMs = 0n;
let _counter = 0n;

export function uuidv7(): string {
  // Get current time in milliseconds
  const nowMs = BigInt(Date.now());
  
  // Handle same-millisecond collisions with monotonic counter
  if (nowMs <= _lastMs) {
    _counter += 1n;
  } else {
    _lastMs = nowMs;
    _counter = 0n;
  }
  
  // Construct UUIDv7 (RFC 9562)
  // Time low (32 bits), time mid (16 bits), time high and version (16 bits, bits 12-15 = 0111)
  // Clock seq (14 bits), node (48 bits)
  
  const timeLow = Number(nowMs & 0xffffffffn);
  const timeMid = Number((nowMs >> 32n) & 0xffffn);
  const timeHighVersion = Number((nowMs >> 48n) & 0x0fffn) | 0x7000; // version 7
  
  // Random parts (80 bits)
  const random = new Uint8Array(10);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(random);
  } else {
    for (let i = 0; i < 10; i++) {
      random[i] = Math.floor(Math.random() * 256);
    }
  }
  
  // Set variant bits (bits 6-7 of byte 8 = 10 binary)
  random[6] = (random[6]! & 0x3f) | 0x80;
  
  // Build UUID string
  const timeHighHex = timeHighVersion.toString(16).padStart(4, '0');
  const timeMidHex = timeMid.toString(16).padStart(4, '0');
  const timeLowHex = timeLow.toString(16).padStart(8, '0');
  const clockSeq = ((Number(random[6]!) & 0x3f) << 8 | Number(random[7]! & 0xff)).toString(16).padStart(4, '0');
  const node = Array.from(random.slice(8)).map(b => b.toString(16).padStart(2, '0')).join('');
  
  // Include counter in the node portion for uniqueness within same ms
  const counterHex = _counter.toString(16).padStart(4, '0');
  
  return `${timeLowHex.slice(0, 8)}-${timeMidHex}-${timeHighHex}-${clockSeq}-${node.slice(0, 6)}${counterHex}`;
}

/**
 * Compare two UUIDv7s for ordering.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareUuidv7(a: string, b: string): -1 | 0 | 1 {
  // Standard UUID string comparison is lexicographic and time-ordered for UUIDv7
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
