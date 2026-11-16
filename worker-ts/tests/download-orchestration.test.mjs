import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {CommandExecutionError} from '../src/media/command.ts';
import {
  FALLBACK_COMMAND_NAMES,
  FallbackDownloadError,
  createFallbackStrategies,
  downloadVideo,
  isBilibiliFallbackCommand,
} from '../src/media/download.ts';
import {toPosixPath} from '../src/tasks/paths.ts';

const golden = JSON.parse(
  await readFile(new URL('./fixtures/download-orchestration-golden.json', import.meta.url), 'utf8'),
);

const LAUNCHER = ['<launcher>'];

async function runScenario(scenario) {
  const root = await mkdtemp(join(tmpdir(), 'locus-download-orchestration-'));
  const outputDir = join(root, 'out');
  await mkdir(outputDir, {recursive: true});
  const calls = [];
  const fallbackCalls = [];
  const probeCalls = [];

  for (const name of scenario.existing_files) {
    await writeFile(join(outputDir, name), 'video');
  }

  const runner = async (command) => {
    calls.push(command);
    const index = Math.min(calls.length - 1, scenario.runner_returns.length - 1);
    const entry = scenario.runner_returns[index];
    return {command, returncode: entry.returncode, stdout: entry.stdout, stderr: entry.stderr};
  };

  const strategies = createFallbackStrategies({
    [FALLBACK_COMMAND_NAMES.douyin]: async ({outputDir: dir}) => {
      fallbackCalls.push(FALLBACK_COMMAND_NAMES.douyin);
      if (scenario.fallback_outcome === 'error') {
        throw new FallbackDownloadError('PLATFORM_FALLBACK_FAILED', 'platform rejected the request');
      }
      const target = join(dir, 'fallback.mp4');
      await writeFile(target, 'fallback');
      return target;
    },
    [FALLBACK_COMMAND_NAMES.xiaohongshu]: async ({outputDir: dir}) => {
      fallbackCalls.push(FALLBACK_COMMAND_NAMES.xiaohongshu);
      const target = join(dir, 'fallback.mp4');
      await writeFile(target, 'fallback');
      return target;
    },
    [FALLBACK_COMMAND_NAMES.bilibili]: async ({outputDir: dir}) => {
      fallbackCalls.push(FALLBACK_COMMAND_NAMES.bilibili);
      const target = join(dir, 'fallback.mp4');
      await writeFile(target, 'fallback');
      return target;
    },
  });

  const normalize = (value) => value.replaceAll(toPosixPath(outputDir), '<OUT>');
  const normalizeCommand = (command) => command.map((value) => normalize(value));

  let outcome;
  try {
    const result = await downloadVideo({
      url: scenario.url,
      outputDir,
      launcher: LAUNCHER,
      runner,
      strategies,
      probeXiaohongshuSubtitle: async (url) => {
        probeCalls.push(normalize(url));
      },
    });
    outcome = {
      status: 'ok',
      result: {
        command: normalizeCommand(result.command),
        returncode: result.returncode,
        stdout: normalize(result.stdout),
        stderr: normalize(result.stderr),
      },
    };
  } catch (error) {
    if (!(error instanceof CommandExecutionError)) throw error;
    outcome = {status: 'error', message: normalize(error.message)};
  }

  return {
    runner_commands: calls.map(normalizeCommand),
    fallback_calls: fallbackCalls,
    probe_calls: probeCalls,
    ...outcome,
  };
}

test('download orchestration matches python for all scenarios', async () => {
  for (const scenario of golden) {
    const actual = await runScenario(scenario);
    assert.deepEqual(actual, scenario.expected, scenario.label);
  }
});

test('runner receives the download timeout for every yt-dlp invocation', async () => {
  const observed = [];
  const runner = async (command, options) => {
    observed.push(options?.timeoutMs);
    return {command, returncode: 0, stdout: '', stderr: ''};
  };
  await downloadVideo({
    url: 'https://example.com/v',
    outputDir: join(tmpdir(), 'locus-download-timeout-probe'),
    launcher: ['yt-dlp'],
    runner,
    strategies: [],
    probeXiaohongshuSubtitle: async () => {},
  });
  assert.deepEqual(observed, [20 * 60 * 1000]);
});

test('bilibili fallback command suppresses subtitle detection only for that strategy', () => {
  assert.equal(isBilibiliFallbackCommand(['bilibili-fallback', 'https://www.bilibili.com/v']), true);
  assert.equal(isBilibiliFallbackCommand(['douyin-fallback', 'https://www.douyin.com/v']), false);
  assert.equal(isBilibiliFallbackCommand([]), false);
});
