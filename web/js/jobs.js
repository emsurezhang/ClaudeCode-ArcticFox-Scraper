import { api, showToast } from './api.js';

let pollTimers = new Map();

export async function renderJobs(container) {
  container.innerHTML = `
    <div class="max-w-5xl mx-auto space-y-6">
      <div class="flex items-center justify-between">
        <h2 class="text-2xl font-bold text-gray-800">任务列表</h2>
        <button id="jobs-refresh" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50 transition flex items-center gap-2">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
          刷新
        </button>
      </div>

      <div class="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div id="jobs-table" class="overflow-x-auto">
          <p class="p-10 text-center text-gray-400">加载中...</p>
        </div>
      </div>

      <div id="job-detail" class="hidden bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div class="px-5 py-4 border-b border-gray-100 font-semibold flex items-center justify-between">
          <span>任务详情</span>
          <button id="close-detail" class="text-gray-400 hover:text-gray-600">&times;</button>
        </div>
        <div id="job-detail-content" class="p-5 text-sm max-h-96 overflow-y-auto"></div>
      </div>
    </div>
  `;

  container.querySelector('#jobs-refresh').addEventListener('click', () => loadJobs(container));
  container.querySelector('#close-detail').addEventListener('click', () => {
    container.querySelector('#job-detail').classList.add('hidden');
  });

  await loadJobs(container);
}

async function loadJobs(container) {
  const data = await api.listJobs();
  const tableEl = container.querySelector('#jobs-table');

  if (data.jobs.length === 0) {
    tableEl.innerHTML = '<p class="p-10 text-center text-gray-400">暂无任务</p>';
    return;
  }

  tableEl.innerHTML = `
    <table class="w-full text-sm">
      <thead class="bg-gray-50 border-b border-gray-100">
        <tr>
          <th class="px-5 py-3 text-left font-semibold text-gray-600">ID</th>
          <th class="px-5 py-3 text-left font-semibold text-gray-600">状态</th>
          <th class="px-5 py-3 text-left font-semibold text-gray-600">进度</th>
          <th class="px-5 py-3 text-left font-semibold text-gray-600">创建时间</th>
          <th class="px-5 py-3 text-right font-semibold text-gray-600">操作</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-100">
        ${data.jobs.map(j => renderJobRow(j)).join('')}
      </tbody>
    </table>
  `;

  // Auto-poll running jobs
  data.jobs.filter(j => j.status === 'running' || j.status === 'pending').forEach(j => {
    if (!pollTimers.has(j.jobId)) {
      pollTimers.set(j.jobId, setInterval(() => refreshJob(container, j.jobId), 3000));
    }
  });

  // Cleanup completed job timers
  data.jobs.filter(j => j.status === 'completed' || j.status === 'failed').forEach(j => {
    if (pollTimers.has(j.jobId)) {
      clearInterval(pollTimers.get(j.jobId));
      pollTimers.delete(j.jobId);
    }
  });

  tableEl.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => showJobDetail(container, btn.dataset.id));
  });

  tableEl.querySelectorAll('.retry-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const result = await api.retryJob(btn.dataset.id);
        showToast(`重试任务已创建: ${result.jobId.slice(0, 12)}...`, 'success');
        loadJobs(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  tableEl.querySelectorAll('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await api.cancelJob(btn.dataset.id);
        showToast('任务已取消', 'success');
        loadJobs(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

function renderJobRow(job) {
  const statusColors = {
    pending: 'bg-yellow-100 text-yellow-700',
    running: 'bg-blue-100 text-blue-700',
    completed: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
  };
  return `
    <tr class="hover:bg-gray-50 transition" data-job="${job.jobId}">
      <td class="px-5 py-3 font-mono text-xs text-gray-500">${job.jobId.slice(0, 12)}...</td>
      <td class="px-5 py-3">
        <span class="px-2 py-0.5 rounded text-xs font-medium ${statusColors[job.status] || 'bg-gray-100'}">${job.status}</span>
      </td>
      <td class="px-5 py-3">${job.progress.done}/${job.progress.total}</td>
      <td class="px-5 py-3 text-gray-500">${new Date(job.createdAt).toLocaleString()}</td>
      <td class="px-5 py-3 text-right space-x-2">
        <button class="view-btn text-blue-600 hover:underline text-xs" data-id="${job.jobId}">详情</button>
        <button class="retry-btn text-green-600 hover:underline text-xs" data-id="${job.jobId}">重试</button>
        ${job.status === 'pending' || job.status === 'running' ? `<button class="cancel-btn text-red-600 hover:underline text-xs" data-id="${job.jobId}">取消</button>` : ''}
      </td>
    </tr>
  `;
}

async function refreshJob(container, jobId) {
  const job = await api.getJob(jobId);
  if (job.status === 'completed' || job.status === 'failed') {
    if (pollTimers.has(jobId)) {
      clearInterval(pollTimers.get(jobId));
      pollTimers.delete(jobId);
    }
    loadJobs(container);
  }
}

async function showJobDetail(container, jobId) {
  const job = await api.getJob(jobId);
  const detailEl = container.querySelector('#job-detail');
  const contentEl = container.querySelector('#job-detail-content');

  contentEl.innerHTML = `
    <div class="space-y-3">
      <div class="grid grid-cols-2 gap-4">
        <div><span class="text-gray-500">ID:</span> <code class="text-xs">${job.jobId}</code></div>
        <div><span class="text-gray-500">状态:</span> ${job.status}</div>
        <div><span class="text-gray-500">进度:</span> ${job.progress.done}/${job.progress.total}</div>
        <div><span class="text-gray-500">创建:</span> ${new Date(job.createdAt).toLocaleString()}</div>
      </div>
      ${job.results?.length > 0 ? `
        <div class="border-t pt-3">
          <div class="font-medium mb-2">结果 (${job.results.length})</div>
          ${job.results.map(r => renderResult(r)).join('')}
        </div>
      ` : ''}
      ${job.errors?.length > 0 ? `
        <div class="border-t pt-3">
          <div class="font-medium mb-2 text-red-600">错误 (${job.errors.length})</div>
          ${job.errors.map(e => `<div class="text-red-500 text-xs">${e.url}: ${e.error}</div>`).join('')}
        </div>
      ` : ''}
    </div>
  `;

  detailEl.classList.remove('hidden');
}

function renderResult(result) {
  return `
    <div class="p-3 bg-gray-50 rounded-lg mb-2">
      <div class="font-medium text-gray-800">${result.title || '(无标题)'}</div>
      <div class="text-xs text-gray-500 mt-1">${result.platform} · ${result.url}</div>
      ${result.audioPath ? `<div class="text-xs text-green-600 mt-1">音频: ${result.audioPath}</div>` : ''}
      ${result.transcript ? `<div class="text-xs text-gray-500 mt-1">字幕: ${result.transcript.slice(0, 100)}...</div>` : ''}
    </div>
  `;
}
