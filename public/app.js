let state = { tenant: null, board: null, socket: null, users: new Map() };
const $ = selector => document.querySelector(selector);
const initials = name => name.split(" ").map(part => part[0]).join("").slice(0, 2).toUpperCase();
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || result.error || "Request failed");
  return result;
}
async function init() {
  const [session, orgs, tenants] = await Promise.all([request("/api/session"), request("/api/organizations"), request("/api/tenants")]);
  $("#user-name").textContent = session.user.name;
  $("#org-name").textContent = orgs[0]?.name || "Workspace";
  $("#tenants").innerHTML = tenants.map((tenant, i) => `<div class="tenant ${i === 0 ? "active" : ""}" data-id="${tenant.id}">${tenant.name}</div>`).join("");
  $("#tenants").addEventListener("click", event => { const item = event.target.closest(".tenant"); if (item) selectTenant(tenants.find(t => t.id === item.dataset.id), item); });
  if (tenants[0]) selectTenant(tenants[0]);
}
async function selectTenant(tenant, item) {
  state.tenant = tenant;
  if (item) { document.querySelectorAll(".tenant").forEach(el => el.classList.remove("active")); item.classList.add("active"); }
  $("#tenant-name").textContent = tenant.name.toUpperCase();
  const boards = await request(`/api/boards?tenant_id=${tenant.id}`);
  if (!boards[0]) return;
  state.board = await request(`/api/board/${boards[0].id}?tenant_id=${tenant.id}`);
  renderBoard(); connect();
}
function renderBoard() {
  $("#board-name").textContent = state.board.name;
  $("#board").innerHTML = state.board.columns.map(column => `<section class="column" data-column="${column.id}"><div class="column-head"><span class="column-title">${escapeHtml(column.name)}</span><span class="count">${column.tasks.length}</span></div><div class="tasks">${column.tasks.map(taskHtml).join("")}</div></section>`).join("");
  document.querySelectorAll(".task").forEach(task => { task.addEventListener("click", () => openTask(task.dataset.id)); task.addEventListener("dragstart", event => event.dataTransfer.setData("task", task.dataset.id)); });
  document.querySelectorAll(".column").forEach(column => { column.addEventListener("dragover", event => { event.preventDefault(); column.classList.add("drop-target"); }); column.addEventListener("dragleave", () => column.classList.remove("drop-target")); column.addEventListener("drop", event => moveTask(event, column)); });
}
function taskHtml(task) { return `<article class="task" draggable="true" data-id="${task.id}"><h3>${escapeHtml(task.title)}</h3>${task.description ? `<p>${escapeHtml(task.description)}</p>` : ""}<div class="task-meta"><span>${task.assignee_id ? "Assigned" : "Unassigned"}</span><span class="task-avatar">${task.assignee_id ? "TM" : "+"}</span></div></article>`; }
async function moveTask(event, column) {
  column.classList.remove("drop-target");
  const taskId = event.dataTransfer.getData("task"), task = findTask(taskId);
  if (!task || task.column_id === column.dataset.column) return;
  const optimistic = structuredClone(state.board); task.column_id = column.dataset.column; task.position = column.querySelectorAll(".task").length;
  renderBoard();
  try { await request(`/api/tasks/${task.id}`, { method: "PATCH", headers: { "If-Match": task.version }, body: JSON.stringify({ column_id: task.column_id, position: task.position, version: task.version }) }); }
  catch (error) { state.board = optimistic; renderBoard(); alert(error.message); }
}
function findTask(taskId) { for (const column of state.board.columns) { const task = column.tasks.find(item => item.id === taskId); if (task) return task; } return null; }
function openTask(taskId) { const task = findTask(taskId); if (!task) return; $("#task-id").value = task.id; $("#task-title").value = task.title; $("#task-description").value = task.description; $("#task-dialog").showModal(); }
$("#task-form").addEventListener("submit", async event => { event.preventDefault(); const task = findTask($("#task-id").value); try { await request(`/api/tasks/${task.id}`, { method: "PATCH", headers: { "If-Match": task.version }, body: JSON.stringify({ title: $("#task-title").value, description: $("#task-description").value, version: task.version }) }); $("#task-dialog").close(); } catch (error) { alert(error.message); } });
function connect() {
  if (state.socket) state.socket.close();
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  state.socket = new WebSocket(`${protocol}://${location.host}/ws?tenant_id=${state.tenant.id}`);
  state.socket.onopen = () => { $("#connection").classList.remove("offline"); $("#connection").innerHTML = "<i></i> Live"; state.socket.send(JSON.stringify({ type: "presence", state: "online" })); };
  state.socket.onclose = () => { $("#connection").classList.add("offline"); $("#connection").innerHTML = "<i></i> Offline"; };
  state.socket.onmessage = async event => { const message = JSON.parse(event.data); if (message.type === "task.updated") { state.board = await request(`/api/board/${state.board.id}?tenant_id=${state.tenant.id}`); renderBoard(); } if (message.type === "presence") { state.users.set(message.user.id, message); renderPresence(); } };
}
function renderPresence() { $("#presence").innerHTML = [...state.users.values()].filter(item => item.state === "online").map(item => `<span class="avatar" title="${item.user.name}">${initials(item.user.name)}</span>`).join(""); }
$("#activity-button").onclick = async () => { const logs = await request(`/api/activity?tenant_id=${state.tenant.id}`); $("#activity-list").innerHTML = logs.map(log => `<div class="activity-item"><strong>${escapeHtml(log.user_name || "System")}</strong> ${log.action} ${log.entity_type}<time>${new Date(log.created_at).toLocaleString()}</time></div>`).join("") || "<p>No activity yet.</p>"; $("#activity-panel").classList.remove("hidden"); };
$("#close-activity").onclick = () => $("#activity-panel").classList.add("hidden");
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char])); }
init().catch(error => { $("#board").innerHTML = `<p>${escapeHtml(error.message)}</p>`; });
