// 三平台 fallback 的生产装配。
//
// 三个平台都已接通：抖音走分享页 + 有序候选下载，小红书走公开笔记页 + 候选流，
// B 站走公开 API + DASH 分片合并。平台错误码原样映射成 `CODE: 文案` 进 stderr，
// 宿主据此归类失败；未捕获的错误继续上抛，不会被伪装成平台错误。
import {
  BilibiliFallbackError,
  downloadBilibiliVideo,
} from '../sources/bilibili/index.ts';
import {DouyinFallbackError, downloadDouyinVideo} from '../sources/douyin/index.ts';
import {
  XiaohongshuFallbackError,
  downloadXiaohongshuVideo,
} from '../sources/xiaohongshu/index.ts';
import {
  FALLBACK_COMMAND_NAMES,
  FallbackDownloadError,
  createFallbackStrategies,
} from './download.ts';
import type {FallbackDownloadStrategy} from './download.ts';

export function createPlatformFallbackStrategies(): readonly FallbackDownloadStrategy[] {
  return createFallbackStrategies({
    [FALLBACK_COMMAND_NAMES.douyin]: async (context) => {
      try {
        return await downloadDouyinVideo(context.url, context.outputDir,
          context.onProgress === undefined ? {} : {onProgress: context.onProgress});
      } catch (error) {
        // 平台错误码要原样进入 stderr（`DOUYIN_*: 文案`），宿主据此归类失败。
        if (error instanceof DouyinFallbackError) {
          throw new FallbackDownloadError(error.code, error.message);
        }
        throw error;
      }
    },
    [FALLBACK_COMMAND_NAMES.xiaohongshu]: async (context) => {
      try {
        return await downloadXiaohongshuVideo(context.url, context.outputDir,
          context.onProgress === undefined ? {} : {onProgress: context.onProgress});
      } catch (error) {
        if (error instanceof XiaohongshuFallbackError) {
          throw new FallbackDownloadError(error.code, error.message);
        }
        throw error;
      }
    },
    [FALLBACK_COMMAND_NAMES.bilibili]: async (context) => {
      try {
        return await downloadBilibiliVideo(context.url, context.outputDir, {
          ...(context.onProgress === undefined ? {} : {onProgress: context.onProgress}),
          ...(context.runner === undefined ? {} : {commandRunner: context.runner}),
        });
      } catch (error) {
        if (error instanceof BilibiliFallbackError) {
          throw new FallbackDownloadError(error.code, error.message);
        }
        throw error;
      }
    },
  });
}
