// CTC greedy 解码与词表拼接。对齐生产 `funasr_onnx` 的 SenseVoice 解码路径。
const CTC_BLANK_ID = 0;
/** SentencePiece 的空白记号，拼接后还原为空格。 */
const SENTENCEPIECE_SPACE = '\u2581';
const SENSEVOICE_TAG_PATTERN = /<\|[^|>]+?\|>/g;

export interface CtcLogits {
  readonly data: Float32Array;
  readonly frames: number;
  readonly vocab: number;
}

/**
 * 逐帧 argmax、折叠相邻重复、丢弃 blank。`validFrames` 取 `encoder_out_lens`，
 * 因为 `ctc_logits` 的帧数可能带着尾部补零。
 */
export function greedyDecode(
  logits: CtcLogits,
  validFrames: number,
  blankId: number = CTC_BLANK_ID,
): number[] {
  const frames = Math.min(logits.frames, validFrames);
  const ids: number[] = [];
  let previous = -1;
  for (let frame = 0; frame < frames; frame += 1) {
    const base = frame * logits.vocab;
    let best = 0;
    let bestValue = -Infinity;
    for (let index = 0; index < logits.vocab; index += 1) {
      const value = logits.data[base + index] as number;
      if (value > bestValue) {
        bestValue = value;
        best = index;
      }
    }
    if (best !== previous && best !== blankId) ids.push(best);
    previous = best;
  }
  return ids;
}

/** 把 token id 还原成文本；标签清理与生产 `_clean_sensevoice_text` 一致。 */
export function decodeTokens(ids: readonly number[], tokens: readonly string[]): string {
  const raw = ids.map((id) => tokens[id] ?? '').join('').replaceAll(SENTENCEPIECE_SPACE, ' ');
  return raw.replace(SENSEVOICE_TAG_PATTERN, '').trim();
}
