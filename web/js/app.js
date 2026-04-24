import { api, showToast } from './api.js';
import { renderDashboard } from './dashboard.js';
import { renderScrape } from './scrape.js';
import { renderJobs } from './jobs.js';
import { renderFeeds } from './feeds.js';
import { renderFeedScrape } from './feed-scrape.js';
import { renderPlugins } from './plugins.js';

const pages = {
  dashboard: { title: '概览', render: renderDashboard },
  scrape: { title: '刮削任务', render: renderScrape },
  jobs: { title: '任务列表', render: renderJobs },
  feeds: { title: 'Feed 订阅', render: renderFeeds },
  'feed-scrape': { title: 'Feed 刮削', render: renderFeedScrape },
  plugins: { title: '插件管理', render: renderPlugins },
};

function navigate() {
  const hash = location.hash.replace('#/', '') || 'dashboard';
  const pageKey = hash.split('/')[0];
  const page = pages[pageKey] || pages.dashboard;

  // Update nav active state
  document.querySelectorAll('.nav-link').forEach(el => {
    el.classList.toggle('active', el.dataset.page === pageKey);
  });

  // Update page title
  document.getElementById('page-title').textContent = page.title;

  // Render content
  const content = document.getElementById('content');
  content.innerHTML = `<div class="animate-pulse text-gray-400 p-10 text-center">加载中...</div>`;
  page.render(content).catch(err => {
    content.innerHTML = `<div class="text-red-500 p-10 text-center">加载失败: ${err.message}</div>`;
  });
}

// Sidebar toggle
const sidebar = document.getElementById('sidebar');
const overlay = document.getElementById('sidebar-overlay');
document.getElementById('menu-toggle').addEventListener('click', () => {
  sidebar.classList.toggle('-translate-x-full');
  overlay.classList.toggle('hidden');
});
overlay.addEventListener('click', () => {
  sidebar.classList.add('-translate-x-full');
  overlay.classList.add('hidden');
});

// Hash routing
window.addEventListener('hashchange', navigate);

// Check API status
async function checkApiStatus() {
  try {
    await api.health();
    document.getElementById('api-status').innerHTML = 'API: <span class="text-green-500 font-medium">在线</span>';
  } catch {
    document.getElementById('api-status').innerHTML = 'API: <span class="text-red-500 font-medium">离线</span>';
  }
}

// Init
checkApiStatus();
setInterval(checkApiStatus, 30000);
navigate();
