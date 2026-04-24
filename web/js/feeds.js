import { api, showToast } from './api.js';

export async function renderFeeds(container) {
  container.innerHTML = `
    <div class="max-w-5xl mx-auto space-y-6">
      <div class="flex items-center justify-between">
        <h2 class="text-2xl font-bold text-gray-800">Feed 订阅</h2>
        <div class="flex gap-2">
          <button id="check-all-btn" class="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 transition font-medium flex items-center gap-2">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
            检查全部
          </button>
        </div>
      </div>

      <!-- Add feed -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
        <div class="flex gap-3">
          <input id="feed-url" type="text" placeholder="https://www.youtube.com/@channel 或 https://www.douyin.com/user/..." class="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
          <button id="add-feed-btn" class="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition font-medium">添加</button>
        </div>
      </div>

      <!-- Feed list -->
      <div id="feed-list" class="space-y-3"></div>

      <!-- Check results -->
      <div id="check-results" class="hidden bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div class="px-5 py-4 border-b border-gray-100 font-semibold">检查结果</div>
        <div id="check-results-content" class="p-5"></div>
      </div>
    </div>
  `;

  container.querySelector('#add-feed-btn').addEventListener('click', () => addFeed(container));
  container.querySelector('#feed-url').addEventListener('keypress', e => { if (e.key === 'Enter') addFeed(container); });
  container.querySelector('#check-all-btn').addEventListener('click', () => checkAllFeeds(container));

  await loadFeeds(container);
}

async function loadFeeds(container) {
  const data = await api.listFeeds();
  const listEl = container.querySelector('#feed-list');

  if (data.feeds.length === 0) {
    listEl.innerHTML = '<div class="p-10 text-center text-gray-400 bg-white rounded-xl border border-gray-100">暂无订阅，请添加一个 URL</div>';
    return;
  }

  listEl.innerHTML = data.feeds.map(f => renderFeedCard(f)).join('');

  listEl.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('确定删除此订阅？')) return;
      try {
        await api.removeFeed(btn.dataset.url);
        showToast('订阅已删除', 'success');
        loadFeeds(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  listEl.querySelectorAll('.check-btn').forEach(btn => {
    btn.addEventListener('click', () => checkSingleFeed(container, btn.dataset.url));
  });
}

function renderFeedCard(feed) {
  const lastCheck = feed.lastCheckedAt
    ? new Date(feed.lastCheckedAt).toLocaleString()
    : '从未';
  return `
    <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
      <div class="flex items-start justify-between gap-4">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1">
            <span class="px-2 py-0.5 bg-slate-100 text-slate-700 rounded text-xs font-medium">${feed.platform}</span>
            <span class="text-xs text-gray-400">${feed.knownIds.length} 条已记录</span>
          </div>
          <div class="text-sm text-gray-800 truncate">${feed.url}</div>
          <div class="text-xs text-gray-400 mt-1">上次检查: ${lastCheck}</div>
        </div>
        <div class="flex gap-2 shrink-0">
          <button class="check-btn px-3 py-1.5 text-xs bg-green-600 text-white rounded hover:bg-green-700 transition font-medium" data-url="${feed.url}">
            检查
          </button>
          <button class="delete-btn px-3 py-1.5 text-xs bg-red-50 text-red-600 rounded hover:bg-red-100 transition" data-url="${feed.url}">
            删除
          </button>
        </div>
      </div>
    </div>
  `;
}

async function addFeed(container) {
  const input = container.querySelector('#feed-url');
  const url = input.value.trim();
  if (!url) {
    showToast('请输入 URL', 'error');
    return;
  }
  try {
    await api.addFeed(url);
    showToast('订阅添加成功', 'success');
    input.value = '';
    loadFeeds(container);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function checkSingleFeed(container, url) {
  const btn = container.querySelector(`.check-btn[data-url="${CSS.escape(url)}"]`);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner inline-block mr-1"></div> 检查中';
  }

  try {
    const result = await api.checkFeeds(url, { maxItems: 50 });
    renderCheckResults(container, result.results);
    showToast(`检查完成: ${result.results[0]?.newCount || 0} 条新内容`, 'success');
    loadFeeds(container);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '检查';
    }
  }
}

async function checkAllFeeds(container) {
  const btn = container.querySelector('#check-all-btn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner inline-block mr-1"></div> 检查中...';

  try {
    const result = await api.checkFeeds(null, { maxItems: 50 });
    const totalNew = result.results.reduce((sum, r) => sum + (r.newCount || 0), 0);
    renderCheckResults(container, result.results);
    showToast(`检查完成: ${totalNew} 条新内容`, 'success');
    loadFeeds(container);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `
      <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
      检查全部
    `;
  }
}

function renderCheckResults(container, results) {
  const resultsEl = container.querySelector('#check-results');
  const contentEl = container.querySelector('#check-results-content');

  const totalNew = results.reduce((sum, r) => sum + (r.newCount || 0), 0);

  contentEl.innerHTML = `
    <div class="mb-3 text-sm text-gray-600">
      共检查 ${results.length} 个订阅，发现 <span class="font-bold text-green-600">${totalNew}</span> 条新内容
    </div>
    ${results.map(r => `
      <div class="mb-4 border border-gray-100 rounded-lg overflow-hidden">
        <div class="px-4 py-2 bg-gray-50 text-sm font-medium flex items-center justify-between">
          <span class="truncate">${r.platform} · ${r.url}</span>
          <span class="text-green-600 text-xs">+${r.newCount} 新</span>
        </div>
        ${r.newItems?.length > 0 ? `
          <div class="divide-y divide-gray-100">
            ${r.newItems.map(item => `
              <div class="px-4 py-3">
                <div class="text-sm font-medium text-gray-800">${item.title || '(无标题)'}</div>
                <div class="text-xs text-gray-500 mt-0.5 truncate">${item.url}</div>
                ${item.audioPath ? `<div class="text-xs text-green-600 mt-1">音频已保存: ${item.audioPath}</div>` : ''}
                ${item.transcript ? `<div class="text-xs text-gray-400 mt-1">字幕: ${item.transcript.slice(0, 60)}...</div>` : ''}
              </div>
            `).join('')}
          </div>
        ` : '<div class="px-4 py-3 text-sm text-gray-400">无新内容</div>'}
        ${r.errors?.length > 0 ? `
          <div class="px-4 py-2 bg-red-50">
            ${r.errors.map(e => `<div class="text-xs text-red-500">${e.url}: ${e.error}</div>`).join('')}
          </div>
        ` : ''}
      </div>
    `).join('')}
  `;

  resultsEl.classList.remove('hidden');
}
