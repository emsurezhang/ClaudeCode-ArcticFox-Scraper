import { api, showToast } from './api.js';

export async function renderPlugins(container) {
  const data = await api.plugins();

  container.innerHTML = `
    <div class="max-w-4xl mx-auto space-y-6">
      <h2 class="text-2xl font-bold text-gray-800">插件管理</h2>

      <div class="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 border-b border-gray-100">
            <tr>
              <th class="px-5 py-3 text-left font-semibold text-gray-600">名称</th>
              <th class="px-5 py-3 text-left font-semibold text-gray-600">支持域名</th>
              <th class="px-5 py-3 text-left font-semibold text-gray-600">能力</th>
              <th class="px-5 py-3 text-right font-semibold text-gray-600">操作</th>
            </tr>
          </thead>
          <tbody id="plugins-list" class="divide-y divide-gray-100">
            ${data.plugins.map(p => renderPluginRow(p)).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  container.querySelectorAll('.reload-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      btn.disabled = true;
      btn.textContent = '重载中...';
      try {
        await api.reloadPlugin(name);
        showToast(`插件 ${name} 重载成功`, 'success');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '重载';
      }
    });
  });
}

function renderPluginRow(plugin) {
  const caps = [];
  if (plugin.capabilities.scrapeMetadata) caps.push('元数据');
  if (plugin.capabilities.scrapeContent) caps.push('内容');
  if (plugin.capabilities.downloadAudio) caps.push('音频');
  if (plugin.capabilities.extractTranscript) caps.push('字幕');

  return `
    <tr class="hover:bg-gray-50 transition">
      <td class="px-5 py-4 font-medium text-gray-800">${plugin.name}</td>
      <td class="px-5 py-4 text-gray-500">${plugin.hostnames.join(', ')}</td>
      <td class="px-5 py-4">
        <div class="flex flex-wrap gap-1">
          ${caps.map(c => `<span class="px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs">${c}</span>`).join('')}
        </div>
      </td>
      <td class="px-5 py-4 text-right">
        <button class="reload-btn px-3 py-1.5 text-xs bg-slate-800 text-white rounded hover:bg-slate-700 transition" data-name="${plugin.name}">重载</button>
      </td>
    </tr>
  `;
}
