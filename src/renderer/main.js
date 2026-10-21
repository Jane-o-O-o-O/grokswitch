const PRESETS = [
  {
    id: "deepseek",
    name: "DeepSeek",
    icon: "D",
    color: "#4f46e5",
    data: { model: "deepseek-chat", base_url: "https://api.deepseek.com/v1", api_backend: "chat_completions", context_window: 64000 },
  },
  {
    id: "openai",
    name: "OpenAI",
    icon: "O",
    color: "#10a37f",
    data: { model: "gpt-4o", base_url: "https://api.openai.com/v1", api_backend: "chat_completions", context_window: 128000 },
  },
  {
    id: "anthropic",
    name: "Anthropic",
    icon: "A",
    color: "#d97757",
    data: { model: "claude-3-5-sonnet-20241022", base_url: "https://api.anthropic.com/v1", api_backend: "messages", context_window: 200000 },
  },
  {
    id: "ollama",
    name: "Ollama",
    icon: "Ol",
    color: "#ffffff",
    data: { model: "llama3.1", base_url: "http://localhost:11434/v1", api_backend: "chat_completions", context_window: 128000 },
  },
  {
    id: "siliconflow",
    name: "SiliconFlow",
    icon: "S",
    color: "#7c3aed",
    data: { model: "deepseek-ai/DeepSeek-V3", base_url: "https://api.siliconflow.cn/v1", api_backend: "chat_completions", context_window: 64000 },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    icon: "OR",
    color: "#ffffff",
    data: { model: "anthropic/claude-3.5-sonnet", base_url: "https://openrouter.ai/api/v1", api_backend: "chat_completions", context_window: 200000 },
  },
];

let currentConfig = { models: [] };

function $(selector) {
  return document.querySelector(selector);
}

function render() {
  const app = $("#app");
  app.innerHTML = `
    <div class="app">
      <header>
        <div class="brand">
          <div class="logo">G</div>
          <div>
            <h1>GrokSwitch</h1>
            <p>快速切换 Grok 第三方模型</p>
          </div>
        </div>
        <div class="actions">
          <button class="btn" id="refresh-btn">刷新</button>
          <button class="btn btn-primary" id="add-btn">+ 添加模型</button>
        </div>
      </header>
      <div class="status-bar">
        <div class="status-main">
          <span class="label">当前默认模型</span>
          <span class="value-chip ${currentConfig.default_model ? "active" : "empty"}" id="active-model">${
            escapeHtml(activeDisplayName())
          }</span>
          ${
            currentConfig.default_model
              ? `<span class="value-sub" title="${escapeHtml(currentConfig.default_model)}">id: ${escapeHtml(
                  currentConfig.default_model
                )}</span>`
              : ""
          }
        </div>
        <div class="status-side">
          <span class="label">共 ${currentConfig.models.length} 个模型</span>
          <span class="hint">写入 ~/.grok/config.toml${currentConfig.has_backup ? " · 已有 .bak 备份" : ""}</span>
        </div>
      </div>
      <div class="models-grid" id="models-grid">
        ${currentConfig.models.length ? renderCards() : renderEmpty()}
      </div>
    </div>
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal" id="modal"></div>
    </div>
    <div class="toast" id="toast"></div>
  `;

  bindEvents();
}

function renderCards() {
  return currentConfig.models
    .map((m) => {
      const preset = PRESETS.find((p) => p.id === m.id) || PRESETS.find((p) => m.base_url.includes(p.id)) || null;
      const isActive = currentConfig.default_model === m.id;
      const style = preset ? `background: linear-gradient(135deg, ${preset.color}, ${adjustColor(preset.color, -30)});` : "";
      return `
        <div class="model-card ${isActive ? "active" : ""}" data-id="${escapeHtml(m.id)}">
          <div class="card-header">
            <div class="provider-icon" style="${style}">${preset?.icon || escapeHtml(m.id.slice(0, 2).toUpperCase())}</div>
            <div class="check"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg></div>
          </div>
          <h3 class="model-name">${escapeHtml(m.name || m.id)}</h3>
          <p class="model-id">${escapeHtml(m.model)}</p>
          <div class="model-meta">
            <div class="meta-row"><span class="dot"></span>${escapeHtml(m.base_url)}</div>
            <div class="meta-row"><span class="dot"></span>${escapeHtml(m.api_backend)} · context ${m.context_window || "auto"}</div>
          </div>
          ${isActive ? `<div class="active-badge">当前默认</div>` : ""}
          <div class="card-actions">
            <button data-action="activate" data-id="${escapeHtml(m.id)}" class="${isActive ? "is-active-btn" : ""}">${
              isActive ? "已启用" : "设为默认"
            }</button>
            <button data-action="edit" data-id="${escapeHtml(m.id)}">编辑</button>
            <button data-action="delete" data-id="${escapeHtml(m.id)}">删除</button>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderEmpty() {
  return `
    <div class="empty-state">
      <div class="icon">🤖</div>
      <div>
        <h3>还没有配置模型</h3>
        <p>点击右上角“添加模型”，或使用下方预设快速创建</p>
      </div>
      <button class="btn btn-primary" id="empty-add-btn">添加第一个模型</button>
    </div>
  `;
}

function bindEvents() {
  $("#refresh-btn")?.addEventListener("click", loadConfig);
  $("#add-btn")?.addEventListener("click", () => openModal());
  $("#empty-add-btn")?.addEventListener("click", () => openModal());

  $("#models-grid")?.addEventListener("click", (e) => {
    const target = e.target;
    const card = target.closest(".model-card");
    const action = target.closest("[data-action]");
    const id = action?.dataset.id || card?.dataset.id;
    if (!id) return;

    if (action) {
      const act = action.dataset.action;
      if (act === "activate") activateModel(id);
      else if (act === "edit") openModal(id);
      else if (act === "delete") deleteModel(id);
    } else {
      activateModel(id);
    }
  });
}

async function loadConfig() {
  try {
    currentConfig = await window.electronAPI.loadConfig();
    render();
  } catch (err) {
    currentConfig = { models: [] };
    render();
    showToast(String(err), "error");
  }
}

function activeDisplayName() {
  if (!currentConfig.default_model) return "未设置";
  const m = currentConfig.models.find((x) => x.id === currentConfig.default_model);
  return m?.name || currentConfig.default_model;
}

async function activateModel(id) {
  try {
    if (currentConfig.default_model === id) {
      showToast("已经是当前默认模型", "success", 2500);
      return;
    }
    currentConfig = await window.electronAPI.activateModel(id);
    render();
    const name =
      currentConfig.models.find((m) => m.id === id)?.name || id;
    showToast(
      `已切换到「${name}」并写入配置。若 Grok 正在运行，请新开会话或重启后再用新模型。`,
      "success",
      4500
    );
  } catch (err) {
    showToast(String(err), "error");
  }
}

async function deleteModel(id) {
  if (!confirm(`确定删除模型 "${id}" 吗？`)) return;
  try {
    currentConfig = await window.electronAPI.deleteModel(id);
    render();
    showToast("已删除", "success");
  } catch (err) {
    showToast(String(err), "error");
  }
}

function openModal(editId) {
  const entry = editId ? currentConfig.models.find((m) => m.id === editId) : undefined;
  const modal = $("#modal");
  const overlay = $("#modal-overlay");

  modal.innerHTML = `
    <h2>${entry ? "编辑模型" : "添加模型"}</h2>
    ${!entry ? `<div class="presets">${PRESETS.map((p) => `<span class="preset-chip" data-preset="${p.id}">${p.name}</span>`).join("")}</div>` : ""}
    <div class="form-group">
      <label>模型 ID（唯一标识，如 deepseek-v3）</label>
      <input id="input-id" value="${escapeHtml(entry?.id || "")}" ${entry ? "disabled" : ""} placeholder="deepseek-v3">
    </div>
    <div class="form-group">
      <label>显示名称</label>
      <input id="input-name" value="${escapeHtml(entry?.name || "")}" placeholder="DeepSeek V3">
    </div>
    <div class="form-group">
      <label>API 模型名（传给服务商的 model 字段）</label>
      <input id="input-model" value="${escapeHtml(entry?.model || "")}" placeholder="deepseek-chat">
    </div>
    <div class="form-group">
      <label>Base URL（必须以 /v1 结尾）</label>
      <input id="input-base-url" value="${escapeHtml(entry?.base_url || "")}" placeholder="https://api.deepseek.com/v1">
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>API Backend</label>
        <select id="input-backend">
          <option value="chat_completions" ${entry?.api_backend === "chat_completions" ? "selected" : ""}>chat_completions</option>
          <option value="responses" ${entry?.api_backend === "responses" ? "selected" : ""}>responses</option>
          <option value="messages" ${entry?.api_backend === "messages" ? "selected" : ""}>messages</option>
        </select>
      </div>
      <div class="form-group">
        <label>Context Window</label>
        <input id="input-context" type="number" value="${entry?.context_window ?? ""}" placeholder="64000">
      </div>
    </div>
    <div class="form-group">
      <label>API Key（可选，留空可用环境变量）</label>
      <input id="input-api-key" type="password" value="${escapeHtml(entry?.api_key || "")}" placeholder="sk-...">
    </div>
    <div class="form-group">
      <label>环境变量名（可选，如 DEEPSEEK_API_KEY）</label>
      <input id="input-env-key" value="${escapeHtml(entry?.env_key || "")}" placeholder="DEEPSEEK_API_KEY">
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Max Tokens</label>
        <input id="input-max-tokens" type="number" value="${entry?.max_completion_tokens ?? ""}" placeholder="8192">
      </div>
      <div class="form-group">
        <label>Temperature</label>
        <input id="input-temperature" type="number" step="0.1" value="${entry?.temperature ?? ""}" placeholder="0.7">
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="modal-cancel">取消</button>
      <button class="btn btn-primary" id="modal-save">保存</button>
    </div>
  `;

  overlay.classList.add("open");

  $("#modal-cancel")?.addEventListener("click", closeModal);
  $("#modal-save")?.addEventListener("click", saveModel);

  modal.querySelectorAll(".preset-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const preset = PRESETS.find((p) => p.id === chip.dataset.preset);
      if (preset) fillPreset(preset);
    });
  });
}

function fillPreset(preset) {
  const idInput = $("#input-id");
  if (!idInput.value) idInput.value = preset.id;
  $("#input-name").value = preset.name;
  $("#input-model").value = preset.data.model || "";
  $("#input-base-url").value = preset.data.base_url || "";
  $("#input-backend").value = preset.data.api_backend || "chat_completions";
  $("#input-context").value = String(preset.data.context_window || "");
}

function closeModal() {
  $("#modal-overlay")?.classList.remove("open");
}

async function saveModel() {
  const id = $("#input-id").value.trim();
  const name = $("#input-name").value.trim();
  const model = $("#input-model").value.trim();
  const baseUrl = $("#input-base-url").value.trim();
  const backend = $("#input-backend").value;
  const apiKey = $("#input-api-key").value.trim();
  const envKey = $("#input-env-key").value.trim();
  const context = parseInt($("#input-context").value) || undefined;
  const maxTokens = parseInt($("#input-max-tokens").value) || undefined;
  const temperature = parseFloat($("#input-temperature").value);

  if (!id || !model || !baseUrl) {
    showToast("请填写模型 ID、模型名和 Base URL", "error");
    return;
  }

  const entry = {
    id,
    name: name || id,
    model,
    base_url: baseUrl,
    api_backend: backend,
    context_window: context,
    max_completion_tokens: maxTokens,
    temperature: isNaN(temperature) ? undefined : temperature,
  };

  if (apiKey) entry.api_key = apiKey;
  if (envKey) entry.env_key = envKey;

  try {
    currentConfig = await window.electronAPI.addOrUpdateModel(entry);
    closeModal();
    render();
    showToast("保存成功", "success");
  } catch (err) {
    showToast(String(err), "error");
  }
}

let toastTimer = null;

function showToast(message, type, durationMs = 3000) {
  const toast = $("#toast");
  if (!toast) {
    console.error(`[toast:${type}]`, message);
    return;
  }
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), durationMs);
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function adjustColor(hex, amount) {
  const num = parseInt(hex.replace("#", ""), 16);
  const r = Math.max(0, Math.min(255, (num >> 16) + amount));
  const g = Math.max(0, Math.min(255, ((num >> 8) & 0x00ff) + amount));
  const b = Math.max(0, Math.min(255, (num & 0x0000ff) + amount));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

loadConfig();
