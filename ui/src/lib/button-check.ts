/**
 * button-check.ts
 *
 * Pure logic for analyzing button-press samples to detect onboard-profile
 * collisions (multiple physical mouse buttons emitting the same signal).
 * Used to identify W1 detection issues where buttons duplicate outputs.
 */

export interface PressSample {
  code: number;
  keyName: string;
}

export interface CollisionReport {
  distinct: number; // distinct codes observed
  presses: number; // total presses recorded
  collisions: { code: number; keyName: string; count: number }[]; // codes hit by 2+ *separated* presses
  keyboardCodes: { code: number; keyName: string }[]; // keyboard-range codes from a pointer device (e.g. esc=1)
}

/**
 * Analyzes button-press samples to detect collisions.
 *
 * Heuristic: consecutive identical codes count as one press (held/repeat);
 * the same code re-appearing AFTER a different code increments its press count.
 * collisions = codes with count >= 2.
 *
 * keyboardCodes: for deviceClass "mouse" or "touchpad", codes < 0x100 are
 * considered keyboard-range codes emitted by a pointer device (e.g., esc=1).
 *
 * @param samples array of button/key press samples
 * @param deviceClass device class (mouse, touchpad, keyboard, etc.)
 * @returns CollisionReport with distinct count, presses count, collisions, and keyboard codes
 */
export function analyzePresses(
  samples: PressSample[],
  deviceClass: string
): CollisionReport {
  if (samples.length === 0) {
    return {
      distinct: 0,
      presses: 0,
      collisions: [],
      keyboardCodes: [],
    };
  }

  // Track unique codes in order of first appearance (for keyboardCodes order)
  const distinctCodes = new Map<number, string>(); // code → keyName

  // Track press counts per code: increments when a code re-appears after being separated
  // by a different code (not just different samples, but a run of different codes)
  const pressCounts = new Map<number, number>();

  // Track last code to detect transitions
  let lastCode: number | null = null;

  // Total press count: increments each time we see a code different from the previous
  let pressCount = 0;

  // Process each sample
  for (let i = 0; i < samples.length; i++) {
    const code = samples[i].code;
    const keyName = samples[i].keyName;

    // If code differs from last code, it's a transition (new press)
    if (lastCode === null || code !== lastCode) {
      pressCount++;
      // If this is a re-appearance (already seen this code before),
      // increment its press count
      if (lastCode !== null && distinctCodes.has(code)) {
        pressCounts.set(code, (pressCounts.get(code) ?? 1) + 1);
      }
    }

    // Record distinct code on first appearance
    if (!distinctCodes.has(code)) {
      distinctCodes.set(code, keyName);
      pressCounts.set(code, 1);
    }

    lastCode = code;
  }

  // Identify collisions: codes with press count >= 2
  const collisions: { code: number; keyName: string; count: number }[] = [];
  for (const [code, count] of pressCounts.entries()) {
    if (count >= 2) {
      collisions.push({
        code,
        keyName: distinctCodes.get(code) ?? "",
        count,
      });
    }
  }

  // Identify keyboard codes: for mouse/touchpad, codes < 0x100
  const keyboardCodes: { code: number; keyName: string }[] = [];
  if (deviceClass === "mouse" || deviceClass === "touchpad") {
    for (const [code, keyName] of distinctCodes.entries()) {
      if (code < 0x100) {
        keyboardCodes.push({ code, keyName });
      }
    }
  }

  return {
    distinct: distinctCodes.size,
    presses: pressCount,
    collisions,
    keyboardCodes,
  };
}

/**
 * Returns true when the device is in the curated onboard-fixable set.
 * Curated fixable set v1: G502 X family — usb:046d:c099, c095, receiver 4099.
 * Exported here for Task 6 reuse.
 */
export function isOnboardFixable(dev: { vendor: number; product: number }): boolean {
  return dev.vendor === 0x046d && [0x4099, 0xc099, 0xc095].includes(dev.product);
}
