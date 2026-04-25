/**
 * 社交媒体刮削 API - 核心接口定义
 */

/** 媒体资源项 */
export interface MediaItem {
  type: 'image' | 'video' | 'gif';
  url: string;
  width?: number;
  height?: number;
}

/** 插件能力声明 */
export interface PluginCapabilities {
  scrapeMetadata: boolean;
  scrapeContent: boolean;
  downloadAudio: boolean;
  extractTranscript: boolean;
}

/** 刮削选项 */
export type ScrapeMode = 'list' | 'detail';

export interface ScrapeOptions {
  /** 刮削模式: list=列表, detail=详情 */
  mode?: ScrapeMode;
  /** 是否下载音频 */
  downloadAudio?: boolean;
  /** 是否提取字幕 */
  extractTranscript?: boolean;
  /** 音频下载质量 */
  audioQuality?: 'best' | 'worst';
  /** 使用的浏览器 */
  browser?: string;
  /** 超时时间（毫秒） */
  timeout?: number;
  /** 调试模式 - 显示浏览器窗口，不隐藏 Playwright */
  debug?: boolean;
  /** 滚动策略 (X/Twitter 等): min/max/all */
  scrollStrategy?: 'min' | 'max' | 'all';
  /** 最大收集数量 (list 模式) */
  maxItems?: number;
  /** Playwright 浏览器池（由服务器注入） */
  browserPool?: IBrowserPool;
  /** 音频文件输出目录（默认: 项目上一级目录的 data/YYYY-MM-DD/） */
  audioOutputDir?: string;
  /** Cookie 管理器（由服务器注入） */
  cookieManager?: ICookieManager;
}

/** 刮削结果 */
export interface ScrapeResult {
  /** 原始 URL */
  url: string;
  /** 平台名称 */
  platform: string;
  /** 内容标题 */
  title?: string;
  /** 作者/发布者 */
  author?: string;
  /** 内容描述 */
  description?: string;
  /** 发布时间 */
  publishedAt?: string;
  /** 内容文本（推文/帖子正文） */
  content?: string;
  /** 媒体资源列表 */
  media?: MediaItem[];
  /** 音频文件路径（如果已下载） */
  audioPath?: string;
  /** 字幕/转录文本 */
  transcript?: string;
  /** 字幕语言 */
  transcriptLanguage?: string;
  /** 原始元数据 */
  metadata?: Record<string, unknown>;
  /** 刮削时间戳 */
  scrapedAt: string;
}

/** 平台插件接口 */
export interface IPlatformPlugin {
  /** 插件唯一标识 */
  readonly name: string;
  /** 支持的域名列表 */
  readonly hostnames: string[];
  /** 插件能力声明 */
  readonly capabilities: PluginCapabilities;

  /**
   * 检测 URL 是否可被此插件处理
   */
  canHandle(url: string): boolean;

  /**
   * 刮削内容
   * @param url 目标 URL
   * @param options 刮削选项
   * @returns 刮削结果
   */
  scrape(url: string, options: ScrapeOptions): Promise<ScrapeResult>;
}

/**
 * Playwright addCookies() 兼容的 cookie 记录类型
 */
export interface PlaywrightCookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** Netscape cookie 解析选项 */
export interface ParseCookiesOptions {
  /** 域名过滤函数：返回 true 保留该 cookie，false 丢弃 */
  domainFilter?: (domain: string) => boolean;
}

/** Cookies 缓存管理接口 */
export interface ICookieManager {
  /**
   * 获取指定平台和浏览器的 cookies
   * @param platform 平台名称
   * @param browser 浏览器名称
   * @returns cookies 内容或 undefined
   */
  getCookies(platform: string, browser: string): Promise<string | undefined>;

  /**
   * 设置 cookies
   * @param platform 平台名称
   * @param browser 浏览器名称
   * @param cookies cookies 内容
   */
  setCookies(platform: string, browser: string, cookies: string): Promise<void>;

  /**
   * 清除指定平台的 cookies
   * @param platform 平台名称
   */
  clearCookies(platform: string): Promise<void>;

  /**
   * 检查 cookies 是否存在且未过期
   * @param platform 平台名称
   * @param browser 浏览器名称
   */
  isValid(platform: string, browser: string): Promise<boolean>;

  /**
   * 获取 cookies，如果不存在或失效则从浏览器提取
   * @param platform 平台名称
   * @param browser 浏览器名称
   * @returns cookies 内容
   */
  getOrExtract(platform: string, browser: string): Promise<string>;

  /**
   * 解析 Netscape 格式 cookie 文本，返回 Playwright 兼容的 cookie 记录列表
   * @param content Netscape 格式文本
   * @param options 解析选项（可选域名过滤）
   */
  parseNetscapeCookies(content: string, options?: ParseCookiesOptions): PlaywrightCookieRecord[];

  /**
   * 将缓存中的 cookies 解析后注入到 Playwright BrowserContext
   * @param context Playwright BrowserContext
   * @param platform 平台名称
   * @param browser 浏览器名称
   * @param options 解析选项（可选域名过滤）
   */
  injectIntoContext(
    context: import('playwright').BrowserContext,
    platform: string,
    browser: string,
    options?: ParseCookiesOptions,
  ): Promise<void>;

  /**
   * 强制刷新 cookies：清除磁盘缓存、从浏览器重新提取、注入到 BrowserContext
   * @param context Playwright BrowserContext
   * @param platform 平台名称
   * @param browser 浏览器名称
   * @param options 解析选项（可选域名过滤）
   * @returns true 表示刷新成功，false 表示提取失败
   */
  refreshCookies(
    context: import('playwright').BrowserContext,
    platform: string,
    browser: string,
    options?: ParseCookiesOptions,
  ): Promise<boolean>;
}

/** 插件管理器接口 */
export interface IPluginManager {
  /** 已加载的插件列表 - 实际存储可能包含额外元数据 */
  readonly plugins: Map<string, IPlatformPlugin | unknown>;

  /**
   * 加载单个插件
   * @param pluginPath 插件目录路径
   */
  loadPlugin(pluginPath: string): Promise<IPlatformPlugin>;

  /**
   * 从目录批量加载插件
   * @param dir 插件目录
   */
  loadPluginsFromDirectory(dir: string): Promise<IPlatformPlugin[]>;

  /**
   * 卸载插件
   * @param name 插件名称
   */
  unloadPlugin(name: string): Promise<void>;

  /**
   * 热重载插件
   * @param name 插件名称
   */
  reloadPlugin(name: string): Promise<IPlatformPlugin>;

  /**
   * 根据 URL 查找匹配的插件
   * @param url 目标 URL
   */
  findPluginForUrl(url: string): IPlatformPlugin | undefined;

  /**
   * 监听插件目录变更
   * @param pluginDir 插件目录
   */
  watch(pluginDir: string): void;

  /**
   * 停止监听
   */
  unwatch(): void;
}

/** API 请求体 */
export interface ScrapeRequest {
  urls: string[];
  options?: ScrapeOptions;
}

/** API 响应体 */
export interface ScrapeResponse {
  success: boolean;
  results: ScrapeResult[];
  errors?: {
    url: string;
    error: string;
  }[];
}

/** 插件列表响应 */
export interface PluginsResponse {
  plugins: {
    name: string;
    hostnames: string[];
    capabilities: PluginCapabilities;
  }[];
}

/** Feed 订阅条目 */
export interface FeedEntry {
  /** 订阅 URL */
  url: string;
  /** 平台名称 */
  platform: string;
  /** 添加时间 */
  addedAt: string;
  /** 上次检查时间 */
  lastCheckedAt?: string;
  /** 已知内容 ID 列表（以内容 URL 作为唯一标识） */
  knownIds: string[];
}

/** Feed 检查单项结果 */
export interface FeedCheckItem {
  /** 内容 URL */
  url: string;
  /** 标题 */
  title?: string;
  /** 作者 */
  author?: string;
  /** 发布时间 */
  publishedAt?: string;
  /** 音频文件路径（如果已下载） */
  audioPath?: string;
  /** 字幕/转录文本 */
  transcript?: string;
}

/** Feed 检查结果 */
export interface FeedCheckResult {
  /** 订阅 URL */
  url: string;
  /** 平台名称 */
  platform: string;
  /** 新内容数量 */
  newCount: number;
  /** 新内容列表 */
  newItems: FeedCheckItem[];
  /** 抓取错误 */
  errors?: { url: string; error: string }[];
  /** 检查时间 */
  checkedAt: string;
}

/** 异步刮削任务 */
export interface ScrapeJob {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  urls: string[];
  options: ScrapeOptions;
  results: ScrapeResult[];
  errors: { url: string; error: string }[];
  progress: { total: number; done: number };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/** 错误类型 */
export type ScrapeErrorType =
  | 'UNSUPPORTED_PLATFORM'
  | 'NETWORK_ERROR'
  | 'PARSE_ERROR'
  | 'TIMEOUT'
  | 'AUTH_REQUIRED'
  | 'COOKIES_EXPIRED';

/** 刮削错误 */
export interface ScrapeError {
  type: ScrapeErrorType;
  message: string;
  retryable: boolean;
  originalError?: Error;
}

/** 服务器配置 */
export interface ServerConfig {
  /** 服务器端口 */
  port: number;
  /** 系统日志级别 */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /** 外部插件目录路径 */
  pluginsDir?: string;
  /** 是否启用热加载 */
  hotReload: boolean;
  /** 默认刮削选项 */
  defaultOptions: ScrapeOptions;
  /** 认证配置（token 为空则不启用认证） */
  auth?: {
    token?: string;
    headerName?: string;
  };
  /** Cookies 缓存配置 */
  cookieCache?: {
    cacheDir: string;
    ttlHours: number;
    autoRefresh: boolean;
  };
  /** 网络请求配置 */
  network?: {
    /** 请求超时时间（毫秒），默认 60000 */
    timeout: number;
    /** 重试次数，默认 3 */
    retryCount?: number;
  };
  /** CORS 配置 */
  corsOrigin?: boolean | string;
  /** 平台特定配置 */
  platforms?: Record<string, {
    cookiesFromBrowser?: string;
    [key: string]: unknown;
  }>;
}

/** 浏览器池接口 */
export interface BrowserAllocationOptions {
  usePool?: boolean;
  headless?: boolean;
  userAgent?: string;
  viewport?: {
    width: number;
    height: number;
  };
}

export interface BrowserAllocationHandle {
  context: import('playwright').BrowserContext;
  release(): Promise<void>;
}

export interface IBrowserPool {
  acquire(platform: string, browserName: string): Promise<import('playwright').BrowserContext>;
  release(platform: string, browserName: string, context: import('playwright').BrowserContext): Promise<void>;
  allocate?(
    platform: string,
    browserName: string,
    options?: BrowserAllocationOptions,
  ): Promise<BrowserAllocationHandle>;
  destroy(): Promise<void>;
}

/** 插件 package.json 中的 plugin 字段 */
export interface PluginManifest {
  name: string;
  hostnames: string[];
  capabilities: PluginCapabilities;
}
