// 与 work/asr-spike/metrics/compute.py 相同的字符单位与编辑距离规则：
// 中文逐字；英文/数字按字符切分，并在单词前插入边界标记；标点与空白不参与。
export function units(text) {
  const source = text.toLowerCase();
  const result = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const code = source.codePointAt(index);
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) {
      result.push(char);
      index += 1;
      continue;
    }
    const isAsciiAlnum = /[0-9a-z]/.test(char);
    if (isAsciiAlnum) {
      result.push(' ');
      while (index < source.length && /[0-9a-z]/.test(source[index])) {
        result.push(source[index]);
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return result;
}

export function levenshtein(reference, hypothesis) {
  const rows = reference.length + 1;
  const cols = hypothesis.length + 1;
  let previous = new Int32Array(cols);
  let current = new Int32Array(cols);
  for (let column = 0; column < cols; column += 1) previous[column] = column;
  for (let row = 1; row < rows; row += 1) {
    current[0] = row;
    for (let column = 1; column < cols; column += 1) {
      const cost = reference[row - 1] === hypothesis[column - 1] ? 0 : 1;
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + cost,
      );
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[cols - 1];
}

// 参考为空时返回 null，调用方须把它当作独立的状态而不是 0。
export function characterErrorRate(referenceText, hypothesisText) {
  const reference = units(referenceText);
  if (!reference.length) return {rate: null, distance: null, referenceUnits: 0};
  const hypothesis = units(hypothesisText);
  const distance = levenshtein(reference, hypothesis);
  return {rate: distance / reference.length, distance, referenceUnits: reference.length};
}
