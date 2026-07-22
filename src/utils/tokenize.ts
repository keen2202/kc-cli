// Multilingual, CJK-aware tokenizer shared by task classification (H1) and
// memory relevance retrieval (H2). No external dependencies — CJK segments are
// split into bigrams + single characters to keep recall high without a
// dictionary segmenter.

/**
 * Matches a single CJK / Japanese / Korean character.
 * Covers CJK Unified (+Ext A), compatibility ideographs, Hiragana, Katakana,
 * and Hangul syllables.
 */
const CJK_CHAR =
  /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;

/** Common English stop words (superset of the ones used elsewhere). */
const ENGLISH_STOPWORDS = new Set([
  'the', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at', 'by',
  'for', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'this', 'that', 'these', 'those', 'it', 'its', 'have', 'has', 'had', 'do',
  'does', 'did', 'will', 'would', 'can', 'could', 'should', 'they', 'them',
  'their', 'there', 'here', 'what', 'which', 'who', 'when', 'where', 'why',
  'how', 'you', 'your', 'we', 'us', 'our', 'he', 'she', 'his', 'her', 'my',
  'me', 'so', 'no', 'not', 'up',
]);

/** Common Chinese (and shared CJK) single-character stop words. */
const CJK_STOPWORDS = new Set(
  '的了是在我你他她它和与及或也都就而这那有个们吗呢吧啊把被让给从到对为之其等着过并且很再又'.split('')
);

/** Split a non-CJK run into word tokens (Unicode letters/numbers). */
function addAsciiTokens(run: string, push: (t: string) => void): void {
  const parts = run.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const part of parts) {
    if (part.length >= 2 && !ENGLISH_STOPWORDS.has(part)) {
      push(part);
    }
  }
}

/** Split a CJK run into bigrams plus (non-stopword) single characters. */
function addCjkTokens(run: string, push: (t: string) => void): void {
  const chars = [...run];
  if (chars.length === 1) {
    if (!CJK_STOPWORDS.has(chars[0])) push(chars[0]);
    return;
  }
  // Bigrams for recall (kept even if a component is a stop word)
  for (let k = 0; k + 1 < chars.length; k++) {
    push(chars[k] + chars[k + 1]);
  }
  // Single characters, minus stop words
  for (const c of chars) {
    if (!CJK_STOPWORDS.has(c)) push(c);
  }
}

/**
 * Tokenize free text into a de-duplicated, lower-cased token list.
 * ASCII/Latin/etc. segments are split on whitespace + punctuation; CJK segments
 * are split into bigrams + single characters. Stop words are removed.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  const seen = new Set<string>();
  const push = (t: string): void => {
    if (t && !seen.has(t)) {
      seen.add(t);
      tokens.push(t);
    }
  };

  const n = lower.length;
  let i = 0;
  while (i < n) {
    if (CJK_CHAR.test(lower[i])) {
      let j = i;
      while (j < n && CJK_CHAR.test(lower[j])) j++;
      addCjkTokens(lower.slice(i, j), push);
      i = j;
    } else {
      let j = i;
      while (j < n && !CJK_CHAR.test(lower[j])) j++;
      addAsciiTokens(lower.slice(i, j), push);
      i = j;
    }
  }

  return tokens;
}

/**
 * Stable signature of a text's token set, order- and case-independent.
 * Used as a cache key so equivalent queries share cache entries.
 */
export function tokenSignature(text: string): string {
  return [...tokenize(text)].sort().join('\u0001');
}

/** True if the text contains at least one CJK/Japanese/Korean character. */
export function containsCjk(text: string): boolean {
  return CJK_CHAR.test(text);
}
