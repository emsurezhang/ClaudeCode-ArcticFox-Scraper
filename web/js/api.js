const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '')
  ? 'http://localhost:3000'
  : '';

async function apiFetch(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

export const api = {
  health() {
    return apiFetch('/health');
  },

  plugins() {
    return apiFetch('/api/plugins');
  },

  reloadPlugin(name) {
    return apiFetch(`/api/plugins/${name}/reload`, { method: 'POST' });
  },

  scrape(urls, options = {}) {
    return apiFetch('/api/scrape', {
      method: 'POST',
      body: JSON.stringify({ urls, options }),
    });
  },

  listJobs(status) {
    const query = status ? `?status=${status}` : '';
    return apiFetch(`/api/jobs${query}`);
  },

  getJob(jobId) {
    return apiFetch(`/api/jobs/${jobId}`);
  },

  cancelJob(jobId) {
    return apiFetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
  },

  retryJob(jobId) {
    return apiFetch(`/api/jobs/${jobId}/retry`, { method: 'POST' });
  },

  addFeed(url) {
    return apiFetch('/api/feeds', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
  },

  listFeeds() {
    return apiFetch('/api/feeds');
  },

  removeFeed(url) {
    return apiFetch('/api/feeds', {
      method: 'DELETE',
      body: JSON.stringify({ url }),
    });
  },

  checkFeeds(url, options = {}) {
    const body = url ? { url, options } : { options };
    return apiFetch('/api/feeds/check', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
};

export function showToast(message, type = 'info') {
  const colors = {
    info: 'bg-blue-600',
    success: 'bg-green-600',
    error: 'bg-red-600',
    warning: 'bg-yellow-600',
  };
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${colors[type] || colors.info} text-white px-4 py-3 rounded-lg shadow-lg text-sm max-w-sm`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('hiding');
    setTimeout(() => el.remove(), 300);
  }, 3000);
}
