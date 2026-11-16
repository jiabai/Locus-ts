// 公共转写接口与结果类型。语义对齐 worker/worker_core/asr_runtime/types.py，
// 但刻意不暴露任何模型、运行时或张量类型：调用方只依赖这里。
//
// 取消不在本接口内：按设计文档，取消由 Rust 宿主终止完整进程树完成，
// 异步返回值本身不承诺可中断同步原生推理。
import {ASRUnsupportedModelError} from './errors.ts';

/** 当前唯一支持的模型标识；新任务只接受闭集内的值。 */
export const SUPPORTED_ASR_MODELS = ['iic/SenseVoiceSmall-onnx'] as const;
export type SupportedAsrModel = (typeof SUPPORTED_ASR_MODELS)[number];

/** 历史数据里的旧模型标识：可读取，但作为新任务输入必须拒绝。 */
export const LEGACY_ASR_MODELS = [
  'iic/SenseVoiceSmall',
  'iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404',
] as const;

export const DEFAULT_ASR_LANGUAGE = 'Chinese';

export interface TranscriptSegment {
  /** `seg-0001` 起递增，段序号在整个文字稿内唯一。 */
  readonly id: string;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly text: string;
  /** 仅在确实有说话人信息时出现。 */
  readonly speaker?: string;
}

export interface Transcript {
  /** 各段文本以单个空格拼接，与现有 Python 实现一致。 */
  readonly text: string;
  readonly language: string;
  readonly segments: readonly TranscriptSegment[];
}

export interface Transcriber {
  readonly model: SupportedAsrModel;
  /**
   * 转写一段已完成归一化的本地音频（16 kHz、单声道、PCM WAV）。
   * 失败必须抛出 `ASRError` 子类，不得返回空成功的文字稿。
   */
  transcribe(audioPath: string, language?: string): Promise<Transcript>;
  /** 释放原生会话与内部缓存；重复调用是幂等的。 */
  dispose(): void;
}

export function assertSupportedModel(model: string): SupportedAsrModel {
  if ((SUPPORTED_ASR_MODELS as readonly string[]).includes(model)) {
    return model as SupportedAsrModel;
  }
  if ((LEGACY_ASR_MODELS as readonly string[]).includes(model)) {
    // 旧标识只用于读取历史记录；悄悄映射到 ONNX 会让用户以为目标模型没变。
    throw new ASRUnsupportedModelError(
      'Legacy ASR model is only readable in historical tasks and cannot be used for new tasks.',
      model,
    );
  }
  throw new ASRUnsupportedModelError('Unsupported ASR model.', model);
}
