import { api, showToast } from './api.js';

export async function renderScrape(container) {
  container.innerHTML = `
    <div class="max-w-3xl mx-auto space-y-6">
      <h2 class="text-2xl font-bold text-gray-800">新建刮削任务</h2>

      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6 space-y-5">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">URL 列表（每行一个）</label>
          <textarea id="scrape-urls" rows="5" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm" placeholder="https://www.youtube.com/watch?v=...
https://www.douyin.com/video/..."></textarea>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">模式</label>
            <select id="scrape-mode" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
              <option value="detail">detail（详情）</option>
              <option value="list">list（列表）</option>
            </select>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">最大数量（list 模式）</label>
            <input id="scrape-maxItems" type="number" value="50" min="1" max="1000" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
          </div>
        </div>

        <div class="flex flex-wrap gap-4">
          <label class="flex items-center gap-2 text-sm">
            <input id="scrape-downloadAudio" type="checkbox" class="w-4 h-4 text-blue-600 rounded">
            下载音频
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input id="scrape-extractTranscript" type="checkbox" class="w-4 h-4 text-blue-600 rounded">
            提取字幕
          </label>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">音频输出目录（可选）</label>
            <input id="scrape-audioOutputDir" type="text" placeholder="../data/2026-04-23" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">滚动策略（X/Twitter）</label>
            <select id="scrape-scrollStrategy" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
              <option value="min">min</option>
              <option value="max">max</option>
              <option value="all">all</option>
            </select>
          </div>
        </div>

        <button id="scrape-submit" class="w-full sm:w-auto px-6 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium flex items-center justify-center gap-2">
          <span>提交任务</span>
        </button>

        <div id="scrape-result" class="hidden mt-4 p-4 bg-gray-50 rounded-lg text-sm"></div>
      </div>
    </div>
  `;

  container.querySelector('#scrape-submit').addEventListener('click', async () => {
    const urlsText = container.querySelector('#scrape-urls').value.trim();
    if (!urlsText) {
      showToast('请输入至少一个 URL', 'error');
      return;
    }

    const urls = urlsText.split('\n').map(s => s.trim()).filter(Boolean);
    const options = {
      mode: container.querySelector('#scrape-mode').value,
      downloadAudio: container.querySelector('#scrape-downloadAudio').checked,
      extractTranscript: container.querySelector('#scrape-extractTranscript').checked,
      scrollStrategy: container.querySelector('#scrape-scrollStrategy').value,
    };
    const maxItems = parseInt(container.querySelector('#scrape-maxItems').value, 10);
    if (maxItems) options.maxItems = maxItems;
    const audioOutputDir = container.querySelector('#scrape-audioOutputDir').value.trim();
    if (audioOutputDir) options.audioOutputDir = audioOutputDir;

    const btn = container.querySelector('#scrape-submit');
    btn.disabled = true;
    btn.innerHTML = `<div class="spinner"></div> 提交中...`;

    try {
      const result = await api.scrape(urls, options);
      const resultEl = container.querySelector('#scrape-result');
      resultEl.classList.remove('hidden');
      resultEl.innerHTML = `
        <div class="text-green-700 font-medium mb-1">任务已创建</div>
        <div>Job ID: <code class="bg-white px-1.5 py-0.5 rounded border text-xs">${result.jobId}</code></div>
        <div class="mt-2">
          <a href="#/jobs" class="text-blue-600 hover:underline text-xs">查看任务列表 &rarr;</a>
        </div>
      `;
      showToast('任务创建成功', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<span>提交任务</span>';
    }
  });
}
