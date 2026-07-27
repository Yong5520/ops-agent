// Loop-repetition guard.
//
// Detects when a model (typically a thinking model like qwen3.5-27b) is stuck
// re-stating the same intention without acting: the same short phrase repeats
// consecutively >= 3 times near the tail of the streamed output. When detected,
// the agent loop aborts the stream early and surfaces a friendly message
// instead of letting the model spin to maxSteps (e.g. 50 wasted steps).
//
// Pure + synchronous so it is cheap to call on every text delta. Scans only a
// bounded tail window (last ~500 chars) so the cost is O(window) per call and
// early repeats that the model later moved past are out of scope.

export interface RepetitionDetection {
  /** The repeated phrase (>= minPhraseLen chars). */
  phrase: string;
  /** How many times it repeated consecutively in the tail window. */
  repeatCount: number;
}

export interface RepetitionDetectionOptions {
  /** Tail window size in chars (default 500). */
  window?: number;
  /** Min phrase length to consider a repetition signal (default 8). */
  minPhraseLen?: number;
  /** Min consecutive repeats to flag (default 3). */
  minRepeats?: number;
}

export function detectRepetition(
  text: string,
  opts: RepetitionDetectionOptions = {},
): RepetitionDetection | null {
  const window = opts.window ?? 500;
  const minPhraseLen = opts.minPhraseLen ?? 8;
  const minRepeats = opts.minRepeats ?? 3;

  if (!text) return null;

  const tail = text.slice(-window);
  // Split on one-or-more newlines; empty lines collapse so blank-separated
  // reasoning blocks (qwen emits \n\n between thoughts) count as consecutive.
  const chunks = tail.split(/\n+/).filter((c) => c.length > 0);

  let bestPhrase: string | null = null;
  let bestCount = 0;

  let i = 0;
  while (i < chunks.length) {
    let j = i + 1;
    while (j < chunks.length && chunks[j] === chunks[i]) j++;
    const run = j - i;
    if (run >= minRepeats && chunks[i].length >= minPhraseLen && run > bestCount) {
      bestCount = run;
      bestPhrase = chunks[i];
    }
    i = j;
  }

  if (bestPhrase !== null) {
    return { phrase: bestPhrase, repeatCount: bestCount };
  }
  return null;
}
