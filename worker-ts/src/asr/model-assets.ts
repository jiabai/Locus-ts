// 生产模型资产的固定哈希与目录约定。
// 这是 TypeScript 侧的唯一事实来源：门禁的完整性校验和打包指纹都从这里读。
// 必须与 worker/worker_core/model_download.py 的 ONNX_REQUIRED_ASSET_HASHES 逐项一致，
// 由 scripts/tests/asr-verification-assets.test.mjs 在 CI 上守卫。

export const SENSEVOICE_MODEL_ID = 'iic/SenseVoiceSmall-onnx';
export const VAD_MODEL_ID = 'iic/speech_fsmn_vad_zh-cn-16k-common-onnx';
export const ONNX_CACHE_DIR_NAME = 'onnx';
export const MODEL_VERSION_FILE_NAME = 'MODEL_VERSION.txt';
/** 生产就绪标记与下载时使用的修订，与 Python 侧 `DEFAULT_SENSEVOICE_REVISION` 一致。 */
export const DEFAULT_MODEL_REVISION = 'master';
/**
 * ONNX 仓库不自带 BPE，需从同名 PyTorch 仓库单独取一个文件——这是生产下载器
 * `_place_onnx_bpe_asset` 的行为，不是我们另加的分发方式。
 */
export const BPE_SOURCE_MODEL_ID = 'iic/SenseVoiceSmall';
const BPE_FILE_NAME = 'chn_jpn_yue_eng_ko_spectok.bpe.model';

export const ASR_MODEL_DIR = `models/${SENSEVOICE_MODEL_ID}`;
export const VAD_MODEL_DIR = `models/${VAD_MODEL_ID}`;

/**
 * Python 侧就绪校验使用的同一组文件与哈希。任何一项不符即视为「尚未下载」，
 * 不能降级为「部分可用」——半份模型加载出来的结果没人能解释。
 */
export const ONNX_REQUIRED_ASSET_HASHES: Readonly<Record<string, string>> = {
  [`${ASR_MODEL_DIR}/am.mvn`]:
    '29b3c740a2c0cfc6b308126d31d7f265fa2be74f3bb095cd2f143ea970896ae5',
  [`${ASR_MODEL_DIR}/config.yaml`]:
    'f71e239ba36705564b5bf2d2ffd07eece07b8e3f2bbf6d2c99d8df856339ac19',
  [`${ASR_MODEL_DIR}/configuration.json`]:
    'c57f6a580d63f7465c6a22ba95847aee05a1ae1181f5abddffb943d9febda061',
  [`${ASR_MODEL_DIR}/model_quant.onnx`]:
    '21dc965f689a78d1604717bf561e40d5a236087c85a95584567835750549e822',
  [`${ASR_MODEL_DIR}/tokens.json`]:
    'a2594fc1474e78973149cba8cd1f603ebed8c39c7decb470631f66e70ce58e97',
  [`${ASR_MODEL_DIR}/chn_jpn_yue_eng_ko_spectok.bpe.model`]:
    'aa87f86064c3730d799ddf7af3c04659151102cba548bce325cf06ba4da4e6a8',
  [`${VAD_MODEL_DIR}/model_quant.onnx`]:
    '5289eb2aa3c9af2d7a4284bcfa7c3ceb81d360814ed4203239b6c5d0569da8a1',
};

/**
 * 生产就绪校验没有覆盖、但会改变推理结果的文件：VAD 的 `config.yaml` 决定分段参数，
 * `am.mvn` 决定归一化。它们同样固定，避免「哈希全对但分段变了」。
 */
export const ADDITIONAL_ASSET_HASHES: Readonly<Record<string, string>> = {
  [`${VAD_MODEL_DIR}/config.yaml`]:
    '2ef334f2d7776edd86ed696296774f87550206c256bfabc597872ad861831589',
  [`${VAD_MODEL_DIR}/am.mvn`]:
    '6820fef9687708c4fc3fab2530179c8fcea6262daa25514380056cd8f6eb1754',
};

/** 就绪标记里必须出现的两个模型标识。 */
export function expectedMarkerModels(): readonly string[] {
  return [SENSEVOICE_MODEL_ID, VAD_MODEL_ID];
}

/**
 * 一次性拿到全部固定哈希。Python 的 `_validate_onnx_model_cache` 与
 * `download_asr_model_cache` 都接受同一用途的 `onnx_asset_hashes` 覆盖参数，
 * 供门禁和测试替换资产集；生产路径永远用这里的固定值。
 */
export function pinnedAssetHashes(): Readonly<Record<string, string>> {
  return {...ONNX_REQUIRED_ASSET_HASHES, ...ADDITIONAL_ASSET_HASHES};
}

/** 就绪标记的规范内容，与 Python `_write_model_version` 的 ONNX 调用一致。 */
export function modelVersionMarker(): string {
  return [
    `model=${SENSEVOICE_MODEL_ID}`,
    `vad=${VAD_MODEL_ID}`,
    `revision=${DEFAULT_MODEL_REVISION}`,
  ].join('\n') + '\n';
}

/** 一个缓存文件在 ModelScope 上的来处。 */
export interface ModelAssetSource {
  /** 仓库标识，决定请求的 `models/<id>/repo` 路径。 */
  readonly modelId: string;
  /** 文件在仓库内的相对路径。 */
  readonly repositoryPath: string;
}

/**
 * 「哪个缓存文件从哪个仓库的哪个路径来」。键必须与两个哈希表覆盖的文件完全一致，
 * 由 `worker-ts/tests/model-download.test.mjs` 断言，避免新增固定文件却忘了加下载来源。
 * 顺序就是下载顺序：先小文件后大文件，落在同一个 staging 目录里。
 */
export const MODEL_DOWNLOAD_SOURCES: Readonly<Record<string, ModelAssetSource>> = {
  [`${ASR_MODEL_DIR}/config.yaml`]: {
    modelId: SENSEVOICE_MODEL_ID,
    repositoryPath: 'config.yaml',
  },
  [`${ASR_MODEL_DIR}/am.mvn`]: {
    modelId: SENSEVOICE_MODEL_ID,
    repositoryPath: 'am.mvn',
  },
  [`${ASR_MODEL_DIR}/configuration.json`]: {
    modelId: SENSEVOICE_MODEL_ID,
    repositoryPath: 'configuration.json',
  },
  [`${ASR_MODEL_DIR}/tokens.json`]: {
    modelId: SENSEVOICE_MODEL_ID,
    repositoryPath: 'tokens.json',
  },
  [`${ASR_MODEL_DIR}/model_quant.onnx`]: {
    modelId: SENSEVOICE_MODEL_ID,
    repositoryPath: 'model_quant.onnx',
  },
  [`${ASR_MODEL_DIR}/${BPE_FILE_NAME}`]: {
    modelId: BPE_SOURCE_MODEL_ID,
    repositoryPath: BPE_FILE_NAME,
  },
  [`${VAD_MODEL_DIR}/config.yaml`]: {
    modelId: VAD_MODEL_ID,
    repositoryPath: 'config.yaml',
  },
  [`${VAD_MODEL_DIR}/am.mvn`]: {
    modelId: VAD_MODEL_ID,
    repositoryPath: 'am.mvn',
  },
  [`${VAD_MODEL_DIR}/model_quant.onnx`]: {
    modelId: VAD_MODEL_ID,
    repositoryPath: 'model_quant.onnx',
  },
};
