/**
 * 插件管理器 - 支持动态加载和热重载
 */

import { readdir, stat, readFile } from 'fs/promises';
import { join, resolve, basename } from 'path';
import { pathToFileURL } from 'url';
import chokidar from 'chokidar';
import type { IPluginManager, IPlatformPlugin, PluginManifest, PluginCapabilities } from '../interfaces/index.js';
import { createLogger } from './logger.js';

const logger = createLogger('PluginManager');

interface LoadedPlugin {
  plugin: IPlatformPlugin;
  path: string;
  manifest: PluginManifest;
}

export class PluginManager implements IPluginManager {
  readonly plugins: Map<string, LoadedPlugin> = new Map();
  private watcher?: chokidar.FSWatcher;

  /**
   * 从目录加载所有插件
   */
  async loadPluginsFromDirectory(dir: string): Promise<IPlatformPlugin[]> {
    const pluginsDir = resolve(dir);
    const loaded: IPlatformPlugin[] = [];

    try {
      const entries = await readdir(pluginsDir, { withFileTypes: true });
      const pluginDirs = entries.filter(e => e.isDirectory()).map(e => e.name);

      for (const pluginDir of pluginDirs) {
        const pluginPath = join(pluginsDir, pluginDir);
        try {
          const plugin = await this.loadPlugin(pluginPath);
          loaded.push(plugin);
        } catch (err) {
          logger.error(`Failed to load plugin from ${pluginPath}`, err);
        }
      }
    } catch (err) {
      logger.warn(`Plugins directory not found: ${pluginsDir}`, err);
    }

    return loaded;
  }

  /**
   * 加载单个插件
   */
  async loadPlugin(pluginPath: string): Promise<IPlatformPlugin> {
    const resolvedPath = resolve(pluginPath);

    // 读取 package.json
    const packageJsonPath = join(resolvedPath, 'package.json');
    let manifest: PluginManifest;

    try {
      const packageContent = await readFile(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(packageContent);

      if (!packageJson.plugin) {
        throw new Error('Missing "plugin" field in package.json');
      }

      manifest = packageJson.plugin as PluginManifest;
    } catch (err) {
      throw new Error(`Failed to read plugin manifest: ${err}`);
    }

    // 检查是否已存在同名插件
    if (this.plugins.has(manifest.name)) {
      throw new Error(`Plugin "${manifest.name}" is already loaded`);
    }

    // 加载插件模块
    const indexPath = join(resolvedPath, 'index.ts');
    const indexUrl = pathToFileURL(indexPath).href;

    try {
      // 使用动态导入加载插件
      const module = await import(indexUrl + `?t=${Date.now()}`);
      const PluginClass = module.default;

      if (!PluginClass) {
        throw new Error('Plugin must export a default class');
      }

      const plugin: IPlatformPlugin = new PluginClass();

      // 验证插件接口
      this.validatePlugin(plugin, manifest);

      // 存储插件
      this.plugins.set(manifest.name, {
        plugin,
        path: resolvedPath,
        manifest
      });

      logger.info(`Loaded plugin: ${manifest.name} (${manifest.hostnames.join(', ')})`);

      return plugin;
    } catch (err) {
      throw new Error(`Failed to load plugin module: ${err}`);
    }
  }

  /**
   * 卸载插件
   */
  async unloadPlugin(name: string): Promise<void> {
    const loaded = this.plugins.get(name);
    if (!loaded) {
      throw new Error(`Plugin "${name}" not found`);
    }

    this.plugins.delete(name);
    logger.info(`Unloaded plugin: ${name}`);
  }

  /**
   * 热重载插件
   */
  async reloadPlugin(name: string): Promise<IPlatformPlugin> {
    const loaded = this.plugins.get(name);
    if (!loaded) {
      throw new Error(`Plugin "${name}" not found`);
    }

    const pluginPath = loaded.path;
    await this.unloadPlugin(name);
    return this.loadPlugin(pluginPath);
  }

  /**
   * 根据 URL 查找匹配的插件
   */
  findPluginForUrl(url: string): IPlatformPlugin | undefined {
    for (const { plugin } of this.plugins.values()) {
      if (plugin.canHandle(url)) {
        return plugin;
      }
    }
    return undefined;
  }

  /**
   * 监听插件目录变更
   */
  watch(pluginDir: string): void {
    if (this.watcher) {
      logger.warn('Already watching, stopping previous watcher');
      this.watcher.close();
    }

    const resolvedDir = resolve(pluginDir);

    this.watcher = chokidar.watch(resolvedDir, {
      ignored: /(^|[\/\\])\../, // 忽略隐藏文件
      persistent: true,
      depth: 1
    });

    this.watcher
      .on('addDir', (path) => {
        // 新插件目录 - 确保是直接的子目录且插件未加载
        if (dirname(path) === resolvedDir) {
          const pluginName = basename(path);
          if (this.plugins.has(pluginName)) {
            return; // 已加载，忽略
          }
          logger.info(`New plugin directory detected: ${pluginName}`);
          this.loadPlugin(path).catch(err => {
            logger.error('Failed to auto-load plugin', err);
          });
        }
      })
      .on('change', (path) => {
        // 插件文件变更
        if (path.endsWith('index.ts') || path.endsWith('package.json')) {
          const pluginPath = dirname(path);
          if (dirname(pluginPath) === resolvedDir) {
            const pluginName = basename(pluginPath);
            logger.info(`Plugin changed: ${pluginName}`);
            this.reloadPlugin(pluginName).catch(err => {
              logger.error('Failed to reload plugin', err);
            });
          }
        }
      })
      .on('unlinkDir', (path) => {
        // 插件目录删除
        if (dirname(path) === resolvedDir) {
          const pluginName = basename(path);
          logger.info(`Plugin removed: ${pluginName}`);
          this.unloadPlugin(pluginName).catch(() => {
            // 可能已经卸载
          });
        }
      });

    logger.info(`Watching directory: ${resolvedDir}`);
  }

  /**
   * 停止监听
   */
  unwatch(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
      logger.info('Stopped watching');
    }
  }

  /**
   * 验证插件实现
   */
  private validatePlugin(plugin: IPlatformPlugin, manifest: PluginManifest): void {
    if (!plugin.name || typeof plugin.name !== 'string') {
      throw new Error('Plugin must have a "name" property');
    }

    if (!Array.isArray(plugin.hostnames)) {
      throw new Error('Plugin must have a "hostnames" array');
    }

    if (!plugin.capabilities || typeof plugin.capabilities !== 'object') {
      throw new Error('Plugin must have a "capabilities" object');
    }

    if (typeof plugin.canHandle !== 'function') {
      throw new Error('Plugin must have a "canHandle" method');
    }

    if (typeof plugin.scrape !== 'function') {
      throw new Error('Plugin must have a "scrape" method');
    }

    // 验证 manifest 和实现一致
    if (plugin.name !== manifest.name) {
      throw new Error(`Plugin name mismatch: ${plugin.name} !== ${manifest.name}`);
    }
  }

  /**
   * 获取所有插件信息
   */
  getPluginInfos(): { name: string; hostnames: string[]; capabilities: PluginCapabilities }[] {
    return Array.from(this.plugins.values()).map(({ plugin }) => ({
      name: plugin.name,
      hostnames: plugin.hostnames,
      capabilities: plugin.capabilities
    }));
  }
}

// 辅助函数
function dirname(p: string): string {
  return p.substring(0, p.lastIndexOf('/') || p.lastIndexOf('\\'));
}
