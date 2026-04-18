/**
 * Whisper 本地转录工具
 * 使用本地 Whisper 模型从音频提取字幕
 */

import { spawn } from 'child_process';
import { mkdir, readdir, readFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';

interface TranscriptionResult {
  text: string;
  language: string;
  segments?: Array<{
    start: number;
    end: number;
    text: string;
  }>;
}

export class WhisperTranscriber {
  private modelsDir: string;
  private tempDir: string;
  private modelName: string;
  private whisperPath: string;

  constructor(options: {
    modelsDir?: string;
    tempDir?: string;
    modelName?: string;
    whisperPath?: string;
  } = {}) {
    this.modelsDir = options.modelsDir || './models';
    this.tempDir = options.tempDir || './cache/temp';
    this.modelName = options.modelName || 'base';
    this.whisperPath = options.whisperPath || this.findWhisperExecutable();
  }

  /**
   * 查找 whisper 可执行文件
   */
  private findWhisperExecutable(): string {
    // 尝试多个可能的路径（Homebrew 使用 whisper-cli）
    const possiblePaths = [
      './whisper.cpp/main',
      './whisper.cpp/build/bin/main',
      '/opt/homebrew/bin/whisper-cli',  // macOS ARM Homebrew
      '/usr/local/bin/whisper-cli',      // macOS Intel Homebrew
      '/usr/local/bin/whisper',
      '/usr/bin/whisper',
      'whisper-cli',
      'whisper',
    ];

    for (const path of possiblePaths) {
      if (existsSync(path)) {
        console.log(`[Whisper] Found executable: ${path}`);
        return path;
      }
    }

    // 默认返回 whisper-cli，让 spawn 从 PATH 查找
    return 'whisper-cli';
  }

  /**
   * 检查 whisper 是否可用
   */
  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(this.whisperPath, ['-h'], { stdio: 'ignore' });
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
  }

  /**
   * 从音频文件提取字幕
   * @param audioPath 音频文件路径
   * @returns 转录结果
   */
  async transcribe(audioPath: string): Promise<TranscriptionResult | null> {
    console.log(`[Whisper] Starting transcription for: ${audioPath}`);

    // 确保目录存在
    await mkdir(this.tempDir, { recursive: true });

    // 检查 whisper 是否可用
    const isAvailable = await this.isAvailable();
    if (!isAvailable) {
      console.error(`[Whisper] Whisper not found at: ${this.whisperPath}`);
      console.error(`[Whisper] Please install whisper.cpp:`);
      console.error(`  git clone https://github.com/ggerganov/whisper.cpp.git`);
      console.error(`  cd whisper.cpp && make`);
      return null;
    }

    // 检查模型文件是否存在
    const modelPath = join(this.modelsDir, `ggml-${this.modelName}.bin`);
    try {
      await readFile(modelPath);
    } catch {
      console.error(`[Whisper] Model not found: ${modelPath}`);
      console.error(`[Whisper] Please download the model from https://huggingface.co/ggerganov/whisper.cpp`);
      return null;
    }

    // 获取音频时长
    const duration = await this.getAudioDuration(audioPath);
    console.log(`[Whisper] Audio duration: ${duration}s`);

    // 如果音频太长，先分片
    const maxSegmentDuration = 300; // 5分钟一片
    let segments: string[] = [];

    if (duration > maxSegmentDuration) {
      console.log(`[Whisper] Audio too long, splitting into segments...`);
      segments = await this.splitAudio(audioPath, maxSegmentDuration);
    } else {
      segments = [audioPath];
    }

    // 转录每个片段
    const transcriptions: TranscriptionResult[] = [];
    for (let i = 0; i < segments.length; i++) {
      console.log(`[Whisper] Transcribing segment ${i + 1}/${segments.length}...`);
      const result = await this.transcribeSegment(segments[i], i);
      if (result) {
        transcriptions.push(result);
      }

      // 清理临时分片文件（如果不是原文件）
      if (segments[i] !== audioPath) {
        await unlink(segments[i]).catch(() => {});
      }
    }

    // 合并结果
    if (transcriptions.length === 0) {
      return null;
    }

    const mergedText = transcriptions.map(t => t.text).join(' ');
    const detectedLang = transcriptions[0].language;

    console.log(`[Whisper] Transcription complete: ${mergedText.length} characters`);

    return {
      text: mergedText,
      language: detectedLang,
    };
  }

  /**
   * 获取音频时长
   */
  private async getAudioDuration(audioPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const proc = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        audioPath,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
      });

      let output = '';
      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          const duration = parseFloat(output.trim());
          resolve(isNaN(duration) ? 0 : duration);
        } else {
          reject(new Error('Failed to get audio duration'));
        }
      });

      proc.on('error', reject);
    });
  }

  /**
   * 使用 ffmpeg 分割音频
   * 注意：抖音下载的文件可能是视频格式，需要先转换为音频
   */
  private async splitAudio(audioPath: string, segmentDuration: number): Promise<string[]> {
    const outputPattern = join(this.tempDir, `segment_%03d.wav`);

    // 首先将输入文件转换为标准 WAV 格式（处理 m4a/mp4 等各种格式）
    const convertedPath = join(this.tempDir, 'converted_input.wav');

    return new Promise((resolve, reject) => {
      // 第一步：转换输入文件为标准格式
      console.log(`[Whisper] Converting input file to WAV...`);
      const convertProc = spawn('ffmpeg', [
        '-i', audioPath,
        '-ar', '16000',
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        '-y',
        convertedPath,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000,
      });

      let convertStderr = '';
      convertProc.stderr.on('data', (data) => {
        convertStderr += data.toString();
      });

      convertProc.on('close', async (convertCode) => {
        if (convertCode !== 0) {
          console.error(`[Whisper] ffmpeg convert error: ${convertStderr}`);
          reject(new Error(`ffmpeg convert failed with code ${convertCode}`));
          return;
        }

        console.log(`[Whisper] Conversion complete, splitting into segments...`);

        // 第二步：分割转换后的文件
        const splitProc = spawn('ffmpeg', [
          '-i', convertedPath,
          '-f', 'segment',
          '-segment_time', segmentDuration.toString(),
          '-ar', '16000',
          '-ac', '1',
          '-c:a', 'pcm_s16le',
          '-reset_timestamps', '1',
          '-y',
          outputPattern,
        ], {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 120000,
        });

        let splitStderr = '';
        splitProc.stderr.on('data', (data) => {
          splitStderr += data.toString();
        });

        splitProc.on('close', async (splitCode) => {
          // 清理转换后的临时文件
          await unlink(convertedPath).catch(() => {});

          if (splitCode === 0) {
            // 获取生成的文件列表
            const files = await readdir(this.tempDir);
            const segments = files
              .filter(f => f.startsWith('segment_') && f.endsWith('.wav'))
              .map(f => join(this.tempDir, f))
              .sort();
            resolve(segments);
          } else {
            console.error(`[Whisper] ffmpeg split error: ${splitStderr}`);
            reject(new Error(`ffmpeg split failed with code ${splitCode}`));
          }
        });

        splitProc.on('error', reject);
      });

      convertProc.on('error', reject);
    });
  }

  /**
   * 转录单个音频片段
   */
  private async transcribeSegment(audioPath: string, index: number): Promise<TranscriptionResult | null> {
    const modelPath = join(this.modelsDir, `ggml-${this.modelName}.bin`);
    const outputPath = join(this.tempDir, `transcript_${index}`);

    // 检查模型文件是否存在
    if (!existsSync(modelPath)) {
      console.error(`[Whisper] Model not found: ${modelPath}`);
      console.error(`[Whisper] Please download from: https://huggingface.co/ggerganov/whisper.cpp`);
      return null;
    }

    return new Promise((resolve) => {
      // 检测是 whisper-cli 还是 whisper.cpp/main
      const isWhisperCli = this.whisperPath.includes('whisper-cli');

      // 构建参数
      const args = [
        '-m', modelPath,
        '-f', audioPath,
        '-oj', // 输出 JSON
        '-of', outputPath,
      ];

      // whisper-cli 使用 --language auto，main 使用 -l auto
      if (isWhisperCli) {
        args.push('--language', 'auto');
      } else {
        args.push('-l', 'auto');
      }

      const proc = spawn(this.whisperPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 300000, // 5分钟超时
      });

      let stderr = '';
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', async (code) => {
        try {
          // 读取 JSON 输出
          const jsonPath = `${outputPath}.json`;
          const content = await readFile(jsonPath, 'utf-8');
          const result = JSON.parse(content);

          // 清理临时文件
          await unlink(jsonPath).catch(() => {});

          // 提取文本 - 新版 whisper-cli 使用 transcription 数组
          let text = '';
          if (result.text) {
            // 旧版格式
            text = result.text.trim();
          } else if (result.transcription && Array.isArray(result.transcription)) {
            // 新版格式 - 合并所有片段
            text = result.transcription.map((t: any) => t.text).join('');
          }

          const language = result.result?.language || result.language || 'unknown';

          if (text) {
            resolve({
              text,
              language,
              segments: result.transcription || result.segments,
            });
          } else {
            console.log('[Whisper] No text found in result');
            resolve(null);
          }
        } catch (err) {
          console.error(`[Whisper] Failed to read transcription result:`, err);
          resolve(null);
        }
      });

      proc.on('error', (err) => {
        console.error(`[Whisper] Failed to run whisper:`, err);
        resolve(null);
      });
    });
  }

  /**
   * 列出可用模型
   */
  async listAvailableModels(): Promise<string[]> {
    try {
      const files = await readdir(this.modelsDir);
      return files
        .filter(f => f.startsWith('ggml-') && f.endsWith('.bin'))
        .map(f => f.replace('ggml-', '').replace('.bin', ''));
    } catch {
      return [];
    }
  }
}
