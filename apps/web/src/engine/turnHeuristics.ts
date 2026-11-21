const CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/g;

// Pure Mandarin / English listener backchannels that should NOT trigger hard barge-in
const BACKCHANNEL_RE =
  /^(?:嗯+|恩+|哦+|噢+|啊+|对+|对对+|好+|好的|行|是的|没错|明白|知道了|懂了|了解|原来如此|有道理|确实|可以|ok|okay|yeah|yep|uh-?huh|mhm|right|got it)[。，！？.,!\s]*$/i;

// Explicit complete-turn endings in Chinese/English -> fast-finalize (~260ms)
const COMPLETE_TURN_END_RE =
  /(?:[。！？?!]|吗|呢|吧|么|怎么样|怎么走|多少钱|多少度|几点|在哪|在哪里|为什么|可以吗|好不好|是不是|对不对|推荐一下|介绍一下|查一下|看看)$/;

// Hesitation / continuation endings in Chinese -> extend silence window (~1050ms)
const CONTINUATION_END_RE =
  /(?:[，、,;：:]|的|了|和|与|或|或者|然后|但是|不过|可是|如果|因为|所以|而且|并且|那个|就是|嗯+|啊+|呃+|这个|其实|比如)$/;

// Real-time / search-heavy intent cues -> longer S1 (~22-40 chars) for positive Relay Margin
const SEARCH_INTENT_RE =
  /(?:天气|气温|下雨|汇率|股价|股票|金价|新闻|最新|最近|航班|高铁|火车|地铁|门票|预约|营业时间|推荐|附近|怎么走|多少钱|排行|发布|进展|比分|价格|查一下|帮我查|搜索|weather|news|price|latest)/i;

/**
 * Returns true if the interim utterance is a pure listener backchannel
 * (e.g. "嗯", "好的", "对", "明白") that should not interrupt ongoing TTS.
 */
export function isBackchannelUtterance(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return BACKCHANNEL_RE.test(trimmed);
}

/**
 * Computes a semantic-aware silence duration (ms) before sending audioStreamEnd.
 * - Complete Chinese questions/statements finalize quickly (~260ms)
 * - Mid-thought hesitation/connector endings get extended patience (~1050ms)
 */
export function computeSemanticSilenceMs(interimText: string, baseSilenceMs: number): number {
  const trimmed = interimText.trim();
  if (!trimmed) return baseSilenceMs;

  if (CONTINUATION_END_RE.test(trimmed)) {
    return Math.max(1050, Math.round(baseSilenceMs * 1.9));
  }
  if (COMPLETE_TURN_END_RE.test(trimmed)) {
    return Math.min(260, baseSilenceMs);
  }
  return baseSilenceMs;
}

/**
 * Decides whether the user's turn likely benefits from a slightly longer S1
 * opening sentence (to cover Google Search grounding latency with a positive Relay Margin)
 * versus a snappy short opening for casual chat.
 */
export function pickOpeningLengthStyle(userText: string): 'short' | 'medium' {
  return SEARCH_INTENT_RE.test(userText) ? 'medium' : 'short';
}

/**
 * Normalizes text for comparing a speculative partial ASR hypothesis against
 * the finalized transcript (ignoring trailing punctuation and whitespace).
 */
export function isSpeculativeTranscriptMatch(partial: string, finalText: string): boolean {
  const norm = (s: string) =>
    s
      .trim()
      .replace(/[\s\u3000]+/g, '')
      .replace(/[，,。\.！!？?；;：:]+$/g, '')
      .toLowerCase();
  const a = norm(partial);
  const b = norm(finalText);
  if (!a || !b) return false;
  return a === b;
}

/**
 * Checks whether an interim transcript is substantial enough to start
 * speculative S1 pre-execution while the user finishes speaking.
 */
export function isReadyForSpeculativeDraft(interimText: string): boolean {
  const trimmed = interimText.trim();
  const cjkMatches = trimmed.match(CJK_RE);
  if (cjkMatches && cjkMatches.length >= 8) return true;
  return trimmed.length >= 20;
}

const EXPLICIT_STOP_RE = /^(?:停|停下|等等|等一下|别说了|打住|算了|不对|换个|stop|wait|hold on)/i;

/**
 * Returns true if the user uttered an explicit stop/interrupt command.
 */
export function isExplicitStopCue(text: string): boolean {
  return EXPLICIT_STOP_RE.test(text.trim());
}

function normalizeForEchoCheck(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s\u3000，,。\.！!？?；;：:“”"'‘’（）()《》【】\[\]、—\-]/g, '');
}

/**
 * Detects whether an incoming STT transcript during playback is likely acoustic
 * echo of the assistant's own speaker output (common on phone speakerphones).
 */
export function isEchoOfAssistantSpeech(incomingText: string, assistantText: string): boolean {
  const cleanIncoming = incomingText.trim();
  if (!cleanIncoming || isExplicitStopCue(cleanIncoming)) return false;

  const normIn = normalizeForEchoCheck(cleanIncoming);
  const normOut = normalizeForEchoCheck(assistantText);
  if (normIn.length < 2 || normOut.length < 2) return false;

  // Direct substring match (e.g. phone mic picked up a phrase the assistant just spoke)
  if (normOut.includes(normIn)) return true;

  // Character overlap / bigram similarity for slightly misrecognized echo
  if (normIn.length >= 3) {
    let matchedBigrams = 0;
    const totalBigrams = normIn.length - 1;
    for (let i = 0; i < totalBigrams; i++) {
      if (normOut.includes(normIn.slice(i, i + 2))) {
        matchedBigrams++;
      }
    }
    if (matchedBigrams / totalBigrams >= 0.55) return true;
  }

  // Fallback unigram overlap for short 2-4 char echo fragments
  let matchedChars = 0;
  for (const ch of normIn) {
    if (normOut.includes(ch)) matchedChars++;
  }
  return normIn.length <= 4 && matchedChars / normIn.length >= 0.75;
}

/**
 * Strips accidental tool/function-call syntax or markdown code fences if
 * gemini-3.5-flash-lite ever leaks pseudo-tool output.
 */
export function sanitizeFastOpening(raw: string): string {
  let text = raw
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/\b(?:google_?search|search|call|tool_code|print)\s*\([^)]*\)/gi, '')
    .replace(/\[(?:search|tool|call)[^\]]*\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Remove stray backticks or JSON braces left over
  if (/^[\{\[]/.test(text) && /[\}\]]$/.test(text)) {
    text = '';
  }
  return text;
}

