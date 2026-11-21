import type { SegmentProgress } from '../types/chat';

const CJK_REGEX = /[\u3400-\u9FFF\uF900-\uFAFF]/;
const ABBREVIATIONS = /(?:Dr|Mr|Mrs|Ms|Prof|St|vs|etc|e\.g|i\.e|U\.S|U\.K)\.$/i;

/**
 * Incrementally splits streaming Chinese/English mixed LLM tokens into natural
 * speakable sentences or clauses for low-latency TTS pipelining.
 */
export class SentenceChunker {
  private buffer = '';
  private readonly clauseSplitThreshold: number;
  private readonly minClauseLength: number;

  constructor(options?: { clauseSplitThreshold?: number; minClauseLength?: number }) {
    this.clauseSplitThreshold = options?.clauseSplitThreshold ?? 28;
    this.minClauseLength = options?.minClauseLength ?? 10;
  }

  push(chunk: string): string[] {
    if (!chunk) return [];
    this.buffer += chunk;
    const emitted: string[] = [];

    while (this.buffer.length > 0) {
      const splitIdx = this.findNextBoundary(this.buffer);
      if (splitIdx === -1) break;

      const sentence = this.buffer.slice(0, splitIdx).trim();
      this.buffer = this.buffer.slice(splitIdx).replace(/^[ \t]+/, '');
      if (sentence.length > 0) {
        emitted.push(sentence);
      }
    }

    return emitted;
  }

  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest.length > 0 ? [rest] : [];
  }

  reset(): void {
    this.buffer = '';
  }

  private findNextBoundary(text: string): number {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      // 1. Newline always splits
      if (ch === '\n') {
        return i + 1;
      }

      // 2. Chinese full-width sentence terminators
      if (ch === '。' || ch === '！' || ch === '？' || ch === '；') {
        // Consume any trailing closing quotes/brackets
        let end = i + 1;
        while (end < text.length && /[”’"'」』）)\]]/.test(text[end])) {
          end++;
        }
        return end;
      }

      // 3. Chinese ellipsis ……
      if (ch === '…' && text[i + 1] === '…') {
        return i + 2;
      }

      // 4. English sentence terminators followed by whitespace or CJK
      if ((ch === '.' || ch === '!' || ch === '?') && i + 1 < text.length) {
        const next = text[i + 1];
        const prev = i > 0 ? text[i - 1] : '';
        // Skip decimals like 3.14
        if (ch === '.' && /\d/.test(prev) && /\d/.test(next)) {
          continue;
        }
        if (/\s/.test(next) || CJK_REGEX.test(next)) {
          const candidate = text.slice(0, i + 1);
          if (ch === '.' && ABBREVIATIONS.test(candidate)) {
            continue;
          }
          return i + 1;
        }
      }

      // 5. Long-clause fallback split on Chinese/English commas to minimize TTS TTFA
      if (
        i >= this.clauseSplitThreshold &&
        (ch === '，' || ch === '、' || (ch === ',' && i + 1 < text.length && /\s/.test(text[i + 1])))
      ) {
        const prefixLen = text.slice(0, i + 1).trim().length;
        if (prefixLen >= this.minClauseLength) {
          return i + 1;
        }
      }
    }

    return -1;
  }
}

function normalizeForPrefixMatch(input: string): string {
  return input
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，,]/g, ',')
    .replace(/[。\.]/g, '.')
    .replace(/[！!]/g, '!')
    .replace(/[？?]/g, '?')
    .replace(/[：:]/g, ':')
    .replace(/[；;]/g, ';')
    .replace(/[“”"'‘’]/g, '')
    .toLowerCase();
}

/**
 * Strips an accidental verbatim or lightly-repunctuated echo of the fast opening
 * sentence S1 from the beginning of the grounded model's continuation stream.
 */
export function stripDuplicatePrefix(openingSentence: string, continuation: string): string {
  const cleanOpening = openingSentence.trim();
  const cleanCont = continuation.trimStart();
  if (!cleanOpening || !cleanCont) return continuation;

  // Direct exact prefix match
  if (cleanCont.startsWith(cleanOpening)) {
    return cleanCont.slice(cleanOpening.length).replace(/^[\s，,。\.：:]+/, '');
  }

  // Normalized comparison (handles full-width vs half-width punctuation & spacing)
  const normOpening = normalizeForPrefixMatch(cleanOpening);
  if (normOpening.length < 4) return continuation;

  // Find the smallest index in cleanCont whose normalized prefix matches normOpening
  let acc = '';
  for (let i = 0; i < cleanCont.length; i++) {
    acc += normalizeForPrefixMatch(cleanCont[i]);
    if (acc === normOpening) {
      return cleanCont.slice(i + 1).replace(/^[\s，,。\.：:]+/, '');
    }
    if (acc.length > normOpening.length + 2) {
      break;
    }
  }

  return continuation;
}

/**
 * Truncates a single sentence proportionally to playback progress ratio [0, 1].
 * Uses character-level truncation (snapping to nearby Chinese clause punctuation)
 * for CJK-heavy text, and word-boundary truncation for Latin/English text.
 */
export function truncateTextByRatio(text: string, ratio: number): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (ratio <= 0.02) return '';
  if (ratio >= 0.96) return trimmed;

  const chars = Array.from(trimmed);
  const cjkCount = chars.filter((c) => CJK_REGEX.test(c)).length;
  const isCjkDominant = cjkCount / Math.max(1, chars.length) >= 0.25;

  if (isCjkDominant) {
    const rawIdx = Math.max(1, Math.min(chars.length - 1, Math.round(chars.length * ratio)));
    // Snap to nearby Chinese clause boundary within ±3 chars for cleaner context
    let bestIdx = rawIdx;
    for (let offset = 0; offset <= 3; offset++) {
      if (rawIdx - offset > 1 && /[，、；：。！？]/.test(chars[rawIdx - offset - 1])) {
        bestIdx = rawIdx - offset;
        break;
      }
      if (rawIdx + offset < chars.length && /[，、；：。！？]/.test(chars[rawIdx + offset - 1])) {
        bestIdx = rawIdx + offset;
        break;
      }
    }
    return chars.slice(0, bestIdx).join('').replace(/[，、；：,\s]+$/, '');
  }

  // Space-delimited word boundary truncation for English
  const words = trimmed.split(/\s+/);
  const wordCount = Math.max(1, Math.min(words.length, Math.round(words.length * ratio)));
  return words.slice(0, wordCount).join(' ').replace(/[,;:\s]+$/, '');
}

export interface SpokenTruncationResult {
  spokenText: string;
  unspokenText: string;
  interrupted: boolean;
}

/**
 * Computes the exact text heard by the user across all queued TTS segments
 * using sample-accurate AudioWorklet playback counters.
 */
export function computeSpokenTruncation(
  segments: SegmentProgress[],
  interrupted: boolean,
  locale: 'zh-CN' | 'en' = 'zh-CN'
): SpokenTruncationResult {
  const fullText = segments.map((s) => s.text.trim()).filter(Boolean).join('');
  if (!interrupted) {
    return { spokenText: fullText, unspokenText: '', interrupted: false };
  }

  const marker = locale === 'zh-CN' ? '——[用户打断]' : ' — [interrupted by user]';
  const spokenParts: string[] = [];
  const unspokenParts: string[] = [];

  for (const seg of segments) {
    const segText = seg.text.trim();
    if (!segText) continue;

    const ratio = seg.totalSamples > 0 ? seg.samplesPlayed / seg.totalSamples : 0;

    if (ratio >= 0.96) {
      spokenParts.push(segText);
    } else if (ratio > 0.02) {
      const partial = truncateTextByRatio(segText, ratio);
      if (partial) {
        spokenParts.push(partial);
        const remainder = segText.slice(partial.length);
        if (remainder) unspokenParts.push(remainder);
      } else {
        unspokenParts.push(segText);
      }
    } else {
      unspokenParts.push(segText);
    }
  }

  const joinedSpoken = spokenParts.join('');
  const joinedUnspoken = unspokenParts.join('');

  if (!joinedSpoken) {
    return {
      spokenText: locale === 'zh-CN' ? '[尚未播报即被用户打断]' : '[interrupted before audio began]',
      unspokenText: fullText,
      interrupted: true,
    };
  }

  return {
    spokenText: `${joinedSpoken}${marker}`,
    unspokenText: joinedUnspoken,
    interrupted: true,
  };
}
