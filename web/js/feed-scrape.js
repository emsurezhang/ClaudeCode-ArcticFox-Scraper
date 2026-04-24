import { api, showToast } from './api.js';

export async function renderFeedScrape(container) {
  const feedsData = await api.listFeeds();

  container.innerHTML = `
    <div class="max-w-5xl mx-auto space-y-6">
      <h2 class="text-2xl font-bold text-gray-800">Feed 刮削</h2>

      <div class="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-800">
        <p class="font-medium mb-1">刮削流程</p>
        <p>1. list 模式获取内容列表 → 2. 与已知内容对比筛选新内容 → 3. detail 模式抓取详情并保存音频</p>
      </div>

      <!-- Settings -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-5 space-y-4">
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">音频输出目录</label>
            <input id="fs-audioOutputDir" type="text" placeholder="默认: ../data/YYYY-MM-DD/" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">最大数量 (list)</label>
            <input id="fs-maxItems" type="number" value="50" min="1" max="1000" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">提取字幕</label>
            <label class="flex items-center gap-2 mt-2">
              <input id="fs-extractTranscript" type="checkbox" class="w-4 h-4 text-blue-600 rounded">
              <span class="text-sm">同时提取字幕</span>
            </label>
          </div>
        </div>
      </div>

      <!-- Feed selection -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div class="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div class="flex items-center gap-3">
            <label class="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input id="fs-select-all" type="checkbox" class="w-4 h-4 text-blue-600 rounded" ${feedsData.feeds.length > 0 ? 'checked' : ''}>
              全选
            </label>
            <span class="text-xs text-gray-400">${feedsData.feeds.length} 个订阅</span>
          </div>
          <button id="fs-start-btn" class="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition font-medium flex items-center gap-2">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            开始刮削
          </button>
        </div>

        <div id="fs-feed-list" class="divide-y divide-gray-100">
          ${feedsData.feeds.length === 0
            ? '<div class="p-10 text-center text-gray-400">暂无订阅，请先前往 <a href="#/feeds" class="text-blue-600 hover:underline">Feed 订阅</a> 添加</div>'
            : feedsData.feeds.map(f => renderFeedRow(f)).join('')
          }
        </div>
      </div>

      <!-- Progress -->
      <div id="fs-progress" class="hidden bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div class="px-5 py-4 border-b border-gray-100 font-semibold flex items-center justify-between">
          <span>刮削进度</span>
          <span id="fs-progress-text" class="text-sm text-gray-500 font-normal">0 / 0</span>
        </div>
        <div class="p-5 space-y-3">
          <div class="w-full bg-gray-200 rounded-full h-2">
            <div id="fs-progress-bar" class="bg-blue-600 h-2 rounded-full transition-all duration-300" style="width: 0%"></div>
          </div>
          <div id="fs-progress-log" class="text-sm text-gray-600 space-y-1 max-h-40 overflow-y-auto font-mono text-xs"></div>
        </div>
      </div>

      <!-- Results -->
      <div id="fs-results" class="hidden bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div class="px-5 py-4 border-b border-gray-100 font-semibold">刮削结果</div>
        <div id="fs-results-content" class="p-5"></div>
      </div>
    </div>
  `;

  const selectAll = container.querySelector('#fs-select-all');
  if (selectAll) {
    selectAll.addEventListener('change', () => {
      container.querySelectorAll('.fs-feed-checkbox').forEach(cb => {
        cb.checked = selectAll.checked;
      });
    });
  }

  const startBtn = container.querySelector('#fs-start-btn');
  if (startBtn) {
    startBtn.addEventListener('click', () => startScrape(container, feedsData.feeds));
  }
}

function renderFeedRow(feed) {
  const lastCheck = feed.lastCheckedAt
    ? new Date(feed.lastCheckedAt).toLocaleString()
    : '从未';
  return `
    <div class="flex items-center gap-4 px-5 py-4 hover:bg-gray-50 transition">
      <input type="checkbox" class="fs-feed-checkbox w-4 h-4 text-blue-600 rounded shrink-0" value="${feed.url}" checked>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 mb-0.5">
          <span class="px-2 py-0.5 bg-slate-100 text-slate-700 rounded text-xs font-medium">${feed.platform}</span>
          <span class="text-xs text-gray-400">${feed.knownIds.length} 条已记录</span>
        </div>
        <div class="text-sm text-gray-800 truncate">${feed.url}</div>
        <div class="text-xs text-gray-400">上次检查: ${lastCheck}</div>
      </div>
    </div>
  `;
}

async function startScrape(container, allFeeds) {
  const checkboxes = container.querySelectorAll('.fs-feed-checkbox:checked');
  const urls = Array.from(checkboxes).map(cb => cb.value);

  if (urls.length === 0) {
    showToast('请至少选择一个 Feed', 'error');
    return;
  }

  const options = {
    maxItems: parseInt(container.querySelector('#fs-maxItems').value, 10) || 50,
    downloadAudio: true,
    extractTranscript: container.querySelector('#fs-extractTranscript').checked,
  };
  const audioDir = container.querySelector('#fs-audioOutputDir').value.trim();
  if (audioDir) {
    options.audioOutputDir = audioDir;
  }

  const progressEl = container.querySelector('#fs-progress');
  const progressBar = container.querySelector('#fs-progress-bar');
  const progressText = container.querySelector('#fs-progress-text');
  const progressLog = container.querySelector('#fs-progress-log');
  const resultsEl = container.querySelector('#fs-results');
  const startBtn = container.querySelector('#fs-start-btn');

  progressEl.classList.remove('hidden');
  resultsEl.classList.add('hidden');
  startBtn.disabled = true;
  startBtn.innerHTML = '<div class="spinner inline-block mr-1"></div> 刮削中...';

  const log = (msg) => {
    const line = document.createElement('div');
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    progressLog.appendChild(line);
    progressLog.scrollTop = progressLog.scrollHeight;
  };

  let done = 0;
  const total = urls.length;
  const allResults = [];

  progressText.textContent = `${done} / ${total}`;

  // 串行执行每个 Feed（避免浏览器并发过多 + Whisper 资源冲突）
  for (const url of urls) {
    log(`开始: ${url}`);
    try {
      const result = await api.checkFeeds(url, options);
      allResults.push(...result.results);
      const newCount = result.results[0]?.newCount || 0;
      log(`完成: ${url} → ${newCount} 条新内容`);
    } catch (err) {
      log(`失败: ${url} → ${err.message}`);
      allResults.push({
        url,
        platform: allFeeds.find(f => f.url === url)?.platform || '?',
        newCount: 0,
        newItems: [],
        errors: [{ url, error: err.message }],
        checkedAt: new Date().toISOString(),
      });
    }
    done++;
    progressText.textContent = `${done} / ${total}`;
    progressBar.style.width = `${(done / total) * 100}%`;
  }

  startBtn.disabled = false;
  startBtn.innerHTML = `
    <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
    开始刮削
  `;

  renderResults(container, allResults);
  showToast(`刮削完成: ${allResults.reduce((s, r) => s + (r.newCount || 0), 0)} 条新内容`, 'success');
}

function renderResults(container, results) {
  const resultsEl = container.querySelector('#fs-results');
  const contentEl = container.querySelector('#fs-results-content');
  const totalNew = results.reduce((sum, r) => sum + (r.newCount || 0), 0);
  const totalError = results.reduce((sum, r) => sum + (r.errors?.length || 0), 0);

  contentEl.innerHTML = `
    <div class="flex items-center gap-4 mb-4">
      <div class="px-4 py-2 bg-green-50 text-green-700 rounded-lg text-sm font-medium">
        新内容: ${totalNew} 条
      </div>
      ${totalError > 0 ? `<div class="px-4 py-2 bg-red-50 text-red-700 rounded-lg text-sm font-medium">错误: ${totalError} 条</div>` : ''}
    </div>
    ${results.map(r => `
      <div class="mb-4 border border-gray-100 rounded-lg overflow-hidden">
        <div class="px-4 py-2 bg-gray-50 text-sm font-medium flex items-center justify-between">
          <span class="truncate">${r.platform} · ${r.url}</span>
          <div class="flex gap-2">
            ${r.newCount > 0 ? `<span class="text-green-600 text-xs">+${r.newCount} 新</span>` : ''}
            ${r.errors?.length > 0 ? `<span class="text-red-600 text-xs">${r.errors.length} 错误</span>` : ''}
          </div>
        </div>
        ${r.newItems?.length > 0 ? `
          <div class="divide-y divide-gray-100">
            ${r.newItems.map(item => `
              <div class="px-4 py-3">
                <div class="text-sm font-medium text-gray-800">${item.title || '(无标题)'}</div>
                <div class="text-xs text-gray-500 mt-0.5 truncate">${item.url}</div>
                ${item.audioPath ? `<div class="text-xs text-green-600 mt-1 flex items-center gap-1">
                  <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z"/></svg>
                  ${item.audioPath}
                </div>` : ''}
                ${item.transcript ? `<div class="text-xs text-gray-400 mt-1">字幕: ${item.transcript.slice(0, 80)}...</div>` : ''}
              </div>
            `).join('')}
          </div>
        ` : '<div class="px-4 py-3 text-sm text-gray-400">无新内容</div>'}
        ${r.errors?.length > 0 ? `
          <div class="px-4 py-2 bg-red-50 space-y-1">
            ${r.errors.map(e => `<div class="text-xs text-red-500">${e.url}: ${e.error}</div>`).join('')}
          </div>
        ` : ''}
      </div>
    `).join('')}
  `;

  resultsEl.classList.remove('hidden');
}
