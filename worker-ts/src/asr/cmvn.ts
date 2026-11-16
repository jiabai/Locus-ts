// am.mvn 解析与 CMVN 归一化，对齐 funasr_onnx 的 LoadCmvn。
// 实际格式是两行一组：
//   <AddShift> <dims>
//   <LearnRateCoef> 0 [ ...means ]
import {ASRRuntimeError} from './errors.ts';

export interface Cmvn {
  readonly means: readonly number[];
  readonly vars: readonly number[];
}

const HEADER = /^<(AddShift|Rescale)>$/;

export function parseCmvn(text: string, minDim: number): Cmvn {
  const lines = text.split(/\r?\n/);
  let means: number[] | null = null;
  let vars: number[] | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const head = (lines[index] ?? '').trim().split(/\s+/);
    const match = head[0]?.match(HEADER);
    if (!match) continue;
    const body = (lines[index + 1] ?? '').trim().split(/\s+/);
    if (body[0] !== '<LearnRateCoef>') {
      throw new ASRRuntimeError('ASR model cache is inconsistent.', `am.mvn line ${index + 2}: missing LearnRateCoef`);
    }
    const values = body.slice(3, -1).map(Number);
    if (values.some((value) => !Number.isFinite(value))) {
      throw new ASRRuntimeError('ASR model cache is inconsistent.', 'am.mvn contains a non-numeric value');
    }
    if (match[1] === 'AddShift') means = values;
    else vars = values;
  }
  if (!means || !vars) {
    throw new ASRRuntimeError('ASR model cache is inconsistent.', 'am.mvn is missing AddShift or Rescale');
  }
  if (means.length < minDim || vars.length < minDim) {
    throw new ASRRuntimeError(
      'ASR model cache is inconsistent.',
      `am.mvn dim ${means.length} < required ${minDim}`,
    );
  }
  return {means, vars};
}

/** `(x + means) * vars`，与 `lfr_cmvn` 的 apply_cmvn 逐项一致。 */
export function applyCmvn(rows: readonly Float64Array[], cmvn: Cmvn): Float64Array[] {
  const dim = rows[0]?.length ?? 0;
  const out: Float64Array[] = new Array(rows.length);
  for (let row = 0; row < rows.length; row += 1) {
    const source = rows[row] as Float64Array;
    const target = new Float64Array(dim);
    for (let index = 0; index < dim; index += 1) {
      target[index] = ((source[index] as number) + (cmvn.means[index] as number)) * (cmvn.vars[index] as number);
    }
    out[row] = target;
  }
  return out;
}
