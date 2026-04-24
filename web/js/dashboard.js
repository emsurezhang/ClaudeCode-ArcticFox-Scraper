import { api } from './api.js';

export async function renderDashboard(container) {
  const [health, plugins, jobs, feeds] = await Promise.allSettled([
    api.health(),
    api.plugins(),
    api.listJobs(),
    api.listFeeds(),
  ]);

  const deps = health.status === 'fulfilled' ? health.value.dependencies : {};
  const pluginCount = plugins.status === 'fulfilled' ? plugins.value.plugins.length : '?';
  const jobCount = jobs.status === 'fulfilled' ? jobs.value.jobs.length : '?';
  const feedCount = feeds.status === 'fulfilled' ? feeds.value.feeds.length : '?';

  container.innerHTML = `
    <div class="max-w-5xl mx-auto space-y-6">
      <h2 class="text-2xl font-bold text-gray-800">系统概览</h2>

      <!-- Stats cards -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div class="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <div class="text-sm text-gray-500 mb-1">已加载插件</div>
          <div class="text-3xl font-bold text-blue-600">${pluginCount}</div>
        </div>
        <div class="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <div class="text-sm text-gray-500 mb-1">任务总数</div>
          <div class="text-3xl font-bold text-purple-600">${jobCount}</div>
        </div>
        <div class="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <div class="text-sm text-gray-500 mb-1">Feed 订阅</div>
          <div class="text-3xl font-bold text-green-600">${feedCount}</div>
        </div>
        <div class="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <div class="text-sm text-gray-500 mb-1">API 状态</div>
          <div class="text-3xl font-bold ${health.status === 'fulfilled' ? 'text-green-600' : 'text-red-600'}">
            ${health.status === 'fulfilled' ? '正常' : '异常'}
          </div>
        </div>
      </div>

      <!-- Dependencies -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100">
        <div class="px-5 py-4 border-b border-gray-100 font-semibold">依赖状态</div>
        <div class="p-5 grid grid-cols-2 sm:grid-cols-4 gap-4">
          ${renderDep('yt-dlp', deps.ytDlp)}
          ${renderDep('ffmpeg', deps.ffmpeg)}
          ${renderDep('whisper-cli', deps.whisperCli)}
          ${renderDep('playwright', deps.playwright)}
        </div>
      </div>

      <!-- Quick actions -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100">
        <div class="px-5 py-4 border-b border-gray-100 font-semibold">快捷操作</div>
        <div class="p-5 flex flex-wrap gap-3">
          <a href="#/scrape" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm font-medium">新建刮削任务</a>
          <a href="#/feeds" class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition text-sm font-medium">管理 Feed</a>
          <a href="#/jobs" class="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition text-sm font-medium">查看任务</a>
        </div>
      </div>
    </div>
  `;
}

function renderDep(name, ok) {
  const color = ok ? 'text-green-600 bg-green-50' : 'text-red-600 bg-red-50';
  const icon = ok ? '&#10003;' : '&#10007;';
  return `<div class="flex items-center gap-2 px-3 py-2 rounded-lg ${color} text-sm font-medium">
    <span>${icon}</span> ${name}
  </div>`;
}
