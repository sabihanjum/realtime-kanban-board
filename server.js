const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 3000);
const db = new Database(path.join(__dirname, "kanban.db"));
db.pragma("foreign_keys = ON");
db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));

const id = () => crypto.randomUUID();
const json = (res, status, value) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(value));
};
const body = req => new Promise((resolve, reject) => {
  let raw = "";
  req.on("data", chunk => { raw += chunk; if (raw.length > 1e6) req.destroy(); });
  req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("Invalid JSON")); } });
  req.on("error", reject);
});
const sendError = (res, status, message) => json(res, status, { error: message });

function seed() {
  if (db.prepare("SELECT COUNT(*) count FROM organizations").get().count) return;
  const org = id(), tenant = id(), board = id(), u1 = id(), u2 = id();
  const c1 = id(), c2 = id(), c3 = id();
  const tx = db.transaction(() => {
    db.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").run(org, "Acme Collaborative");
    db.prepare("INSERT INTO tenants(id,organization_id,name) VALUES (?,?,?)").run(tenant, org, "Engineering");
    db.prepare("INSERT INTO users(id,email,name) VALUES (?,?,?)").run(u1, "admin@acme.test", "Asha Admin");
    db.prepare("INSERT INTO users(id,email,name) VALUES (?,?,?)").run(u2, "member@acme.test", "Ravi Member");
    db.prepare("INSERT INTO memberships VALUES (?,?,?,?)").run(u1, org, tenant, "tenant_admin");
    db.prepare("INSERT INTO memberships VALUES (?,?,?,?)").run(u2, org, tenant, "member");
    db.prepare("INSERT INTO boards(id,tenant_id,name) VALUES (?,?,?)").run(board, tenant, "Product Roadmap");
    [[c1, "Backlog", 0], [c2, "In progress", 1], [c3, "Done", 2]].forEach(c => db.prepare("INSERT INTO columns(id,board_id,tenant_id,name,position) VALUES (?,?,?,?,?)").run(c[0], board, tenant, c[1], c[2]));
    db.prepare("INSERT INTO tasks(id,board_id,column_id,tenant_id,title,description,position,created_by) VALUES (?,?,?,?,?,?,?,?)").run(id(), board, c1, tenant, "Invite your team", "Share the demo credentials with a teammate.", 0, u1);
    db.prepare("INSERT INTO tasks(id,board_id,column_id,tenant_id,title,description,position,created_by) VALUES (?,?,?,?,?,?,?,?)").run(id(), board, c2, tenant, "Design conflict strategy", "Use optimistic versions and return 409 on stale writes.", 0, u2);
  });
  tx();
}
seed();

function currentUser(req) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  const email = token || "admin@acme.test";
  return db.prepare("SELECT u.*, m.organization_id, m.tenant_id, m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.email=? LIMIT 1").get(email);
}
function canAccess(user, tenantId, minimum = "member") {
  if (!user || !tenantId) return false;
  const membership = db.prepare("SELECT role FROM memberships WHERE user_id=? AND tenant_id=?").get(user.id, tenantId);
  const levels = { member: 1, tenant_admin: 2, org_admin: 3 };
  return membership && levels[membership.role] >= levels[minimum];
}
function tenantFromEntity(table, entityId) {
  return db.prepare(`SELECT tenant_id FROM ${table} WHERE id=?`).get(entityId)?.tenant_id;
}
const log = (tenantId, userId, type, entityId, action, payload = {}) =>
  db.prepare("INSERT INTO activity_logs(id,tenant_id,user_id,entity_type,entity_id,action,payload) VALUES (?,?,?,?,?,?,?)").run(id(), tenantId, userId, type, entityId, action, JSON.stringify(payload));

const sockets = new Map();
function broadcast(tenantId, event, except) {
  for (const client of sockets.get(tenantId) || []) if (client !== except && client.readyState === 1) client.send(JSON.stringify(event));
}
function boardState(tenantId, boardId) {
  const board = db.prepare("SELECT * FROM boards WHERE id=? AND tenant_id=?").get(boardId, tenantId);
  if (!board) return null;
  return { ...board, columns: db.prepare("SELECT * FROM columns WHERE board_id=? AND tenant_id=? ORDER BY position").all(boardId, tenantId).map(column => ({ ...column, tasks: db.prepare("SELECT * FROM tasks WHERE column_id=? AND tenant_id=? ORDER BY position").all(column.id, tenantId) })) };
}

async function api(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match" }); return res.end(); }
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  if (parsed.pathname === "/api/session") return json(res, 200, { user: currentUser(req) });
  if (!parsed.pathname.startsWith("/api/")) return serveStatic(req, res);
  const user = currentUser(req);
  if (!user) return sendError(res, 401, "Authentication required");
  const parts = parsed.pathname.split("/").filter(Boolean);
  try {
    if (parts[1] === "organizations" && req.method === "POST") {
      if (user.role !== "org_admin") return sendError(res, 403, "Organization admin required");
      const data = await body(req); if (!data.name) return sendError(res, 422, "name is required");
      const organizationId = id();
      db.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").run(organizationId, data.name);
      return json(res, 201, db.prepare("SELECT * FROM organizations WHERE id=?").get(organizationId));
    }
    if (parts[1] === "organizations" && req.method === "GET") return json(res, 200, db.prepare("SELECT * FROM organizations WHERE id=?").all(user.organization_id));
    if (parts[1] === "organizations" && parts[2] && req.method === "DELETE") {
      if (parts[2] !== user.organization_id || user.role !== "org_admin") return sendError(res, 403, "Organization admin required");
      db.prepare("DELETE FROM organizations WHERE id=?").run(parts[2]); return json(res, 200, { deleted: true });
    }
    if (parts[1] === "organizations" && parts[2] && req.method === "PATCH") {
      if (parts[2] !== user.organization_id || user.role !== "org_admin") return sendError(res, 403, "Organization admin required");
      const data = await body(req); if (!data.name) return sendError(res, 422, "name is required");
      db.prepare("UPDATE organizations SET name=? WHERE id=?").run(data.name, parts[2]); return json(res, 200, db.prepare("SELECT * FROM organizations WHERE id=?").get(parts[2]));
    }
    if (parts[1] === "tenants" && req.method === "POST") {
      if (!canAccess(user, user.tenant_id, "tenant_admin")) return sendError(res, 403, "Tenant admin required");
      const data = await body(req); if (!data.name) return sendError(res, 422, "name is required");
      const tenantId = id(); db.prepare("INSERT INTO tenants(id,organization_id,name) VALUES (?,?,?)").run(tenantId, user.organization_id, data.name);
      db.prepare("INSERT INTO memberships(user_id,organization_id,tenant_id,role) VALUES (?,?,?,?)").run(user.id, user.organization_id, tenantId, "tenant_admin");
      return json(res, 201, db.prepare("SELECT * FROM tenants WHERE id=?").get(tenantId));
    }
    if (parts[1] === "tenants" && req.method === "GET") return json(res, 200, db.prepare("SELECT * FROM tenants WHERE organization_id=? AND id IN (SELECT tenant_id FROM memberships WHERE user_id=?)").all(user.organization_id, user.id));
    if (parts[1] === "tenants" && parts[2] && req.method === "DELETE") {
      if (!canAccess(user, parts[2], "tenant_admin")) return sendError(res, 403, "Tenant admin required");
      db.prepare("DELETE FROM tenants WHERE id=?").run(parts[2]); return json(res, 200, { deleted: true });
    }
    if (parts[1] === "tenants" && parts[2] && req.method === "PATCH") {
      if (!canAccess(user, parts[2], "tenant_admin")) return sendError(res, 403, "Tenant admin required");
      const data = await body(req); if (!data.name) return sendError(res, 422, "name is required");
      db.prepare("UPDATE tenants SET name=? WHERE id=?").run(data.name, parts[2]); return json(res, 200, db.prepare("SELECT * FROM tenants WHERE id=?").get(parts[2]));
    }
    if (parts[1] === "boards" && req.method === "POST") {
      const data = await body(req); data.tenant_id = data.tenant_id || parsed.searchParams.get("tenant_id");
      if (!canAccess(user, data.tenant_id, "tenant_admin")) return sendError(res, 403, "Tenant admin required");
      if (!data.name) return sendError(res, 422, "name is required");
      const boardId = id(); db.prepare("INSERT INTO boards(id,tenant_id,name) VALUES (?,?,?)").run(boardId, data.tenant_id, data.name);
      log(data.tenant_id, user.id, "board", boardId, "created", { name: data.name });
      return json(res, 201, db.prepare("SELECT * FROM boards WHERE id=?").get(boardId));
    }
    if (parts[1] === "boards" && req.method === "GET") {
      if (!canAccess(user, parsed.searchParams.get("tenant_id"))) return sendError(res, 403, "Tenant access denied");
      return json(res, 200, db.prepare("SELECT * FROM boards WHERE tenant_id=? ORDER BY created_at").all(parsed.searchParams.get("tenant_id")));
    }
    if (parts[1] === "boards" && parts[2] && req.method === "DELETE") {
      const tenantId = tenantFromEntity("boards", parts[2]); if (!canAccess(user, tenantId, "tenant_admin")) return sendError(res, 403, "Tenant admin required");
      db.prepare("DELETE FROM boards WHERE id=?").run(parts[2]); return json(res, 200, { deleted: true });
    }
    if (parts[1] === "boards" && parts[2] && req.method === "PATCH") {
      const tenantId = tenantFromEntity("boards", parts[2]); if (!canAccess(user, tenantId, "tenant_admin")) return sendError(res, 403, "Tenant admin required");
      const data = await body(req); if (!data.name) return sendError(res, 422, "name is required");
      db.prepare("UPDATE boards SET name=?, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(data.name, parts[2]); return json(res, 200, db.prepare("SELECT * FROM boards WHERE id=?").get(parts[2]));
    }
    if (parts[1] === "columns" && req.method === "POST") {
      const data = await body(req), board = db.prepare("SELECT * FROM boards WHERE id=?").get(data.board_id);
      if (!board || !canAccess(user, board.tenant_id, "tenant_admin")) return sendError(res, 403, "Tenant admin required");
      if (!data.name) return sendError(res, 422, "name is required");
      const columnId = id(); db.prepare("INSERT INTO columns(id,board_id,tenant_id,name,position) VALUES (?,?,?,?,?)").run(columnId, board.id, board.tenant_id, data.name, Number(data.position || 0));
      log(board.tenant_id, user.id, "column", columnId, "created", { name: data.name });
      return json(res, 201, db.prepare("SELECT * FROM columns WHERE id=?").get(columnId));
    }
    if (parts[1] === "columns" && parts[2] && req.method === "DELETE") {
      const tenantId = tenantFromEntity("columns", parts[2]); if (!canAccess(user, tenantId, "tenant_admin")) return sendError(res, 403, "Tenant admin required");
      db.prepare("DELETE FROM columns WHERE id=?").run(parts[2]); return json(res, 200, { deleted: true });
    }
    if (parts[1] === "columns" && parts[2] && req.method === "PATCH") {
      const tenantId = tenantFromEntity("columns", parts[2]); if (!canAccess(user, tenantId, "tenant_admin")) return sendError(res, 403, "Tenant admin required");
      const data = await body(req); if (!data.name && data.position === undefined) return sendError(res, 422, "name or position is required");
      const name = data.name || db.prepare("SELECT name FROM columns WHERE id=?").get(parts[2]).name;
      const position = data.position === undefined ? db.prepare("SELECT position FROM columns WHERE id=?").get(parts[2]).position : Number(data.position);
      db.prepare("UPDATE columns SET name=?, position=?, version=version+1 WHERE id=?").run(name, position, parts[2]); return json(res, 200, db.prepare("SELECT * FROM columns WHERE id=?").get(parts[2]));
    }
    if (parts[1] === "tasks" && req.method === "POST") {
      const data = await body(req), column = db.prepare("SELECT * FROM columns WHERE id=?").get(data.column_id);
      if (!column || !canAccess(user, column.tenant_id)) return sendError(res, 403, "Tenant access denied");
      if (!data.title) return sendError(res, 422, "title is required");
      const taskId = id(); db.prepare("INSERT INTO tasks(id,board_id,column_id,tenant_id,title,description,position,assignee_id,created_by) VALUES (?,?,?,?,?,?,?,?,?)").run(taskId, column.board_id, column.id, column.tenant_id, data.title, data.description || "", Number(data.position || 0), data.assignee_id || null, user.id);
      log(column.tenant_id, user.id, "task", taskId, "created", { title: data.title });
      const created = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId); broadcast(column.tenant_id, { type: "task.updated", task: created }, null);
      return json(res, 201, created);
    }
    if (parts[1] === "board" && parts[2]) {
      const tenantId = parsed.searchParams.get("tenant_id") || tenantFromEntity("boards", parts[2]);
      if (!canAccess(user, tenantId)) return sendError(res, 403, "Tenant access denied");
      if (req.method === "GET") return json(res, 200, boardState(tenantId, parts[2]));
    }
    if (parts[1] === "tasks" && parts[2]) {
      const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(parts[2]);
      if (!task || !canAccess(user, task.tenant_id)) return sendError(res, 404, "Task not found");
      if (req.method === "PATCH") {
        const data = await body(req);
        const version = Number(req.headers["if-match"] || data.version);
        if (version !== task.version) return sendError(res, 409, { message: "Conflict: task has changed", current: task });
        const allowed = ["title", "description", "column_id", "position", "assignee_id"];
        const updates = Object.fromEntries(allowed.filter(k => data[k] !== undefined).map(k => [k, data[k]]));
        if (updates.column_id && !db.prepare("SELECT 1 FROM columns WHERE id=? AND tenant_id=? AND board_id=?").get(updates.column_id, task.tenant_id, task.board_id)) return sendError(res, 422, "Column belongs to another board");
        const keys = Object.keys(updates);
        if (!keys.length) return json(res, 200, task);
        const nextVersion = task.version + 1;
        db.prepare(`UPDATE tasks SET ${keys.map(k => `${k}=@${k}`).join(",")}, version=@version, updated_at=CURRENT_TIMESTAMP WHERE id=@id AND version=@oldVersion`).run({ ...updates, id: task.id, version: nextVersion, oldVersion: task.version });
        const updated = db.prepare("SELECT * FROM tasks WHERE id=?").get(task.id);
        log(task.tenant_id, user.id, "task", task.id, "updated", updates);
        broadcast(task.tenant_id, { type: "task.updated", task: updated }, null);
        return json(res, 200, updated);
      }
      if (req.method === "DELETE") {
        db.prepare("DELETE FROM tasks WHERE id=?").run(task.id); log(task.tenant_id, user.id, "task", task.id, "deleted");
        broadcast(task.tenant_id, { type: "task.deleted", task_id: task.id }, null); return json(res, 200, { deleted: true });
      }
    }
    if (parts[1] === "activity" && req.method === "GET") {
      const tenantId = parsed.searchParams.get("tenant_id");
      if (!canAccess(user, tenantId)) return sendError(res, 403, "Tenant access denied");
      return json(res, 200, db.prepare("SELECT a.*, u.name user_name FROM activity_logs a LEFT JOIN users u ON u.id=a.user_id WHERE a.tenant_id=? ORDER BY a.created_at DESC LIMIT 100").all(tenantId));
    }
    return sendError(res, 404, "Route not found");
  } catch (error) { console.error(error); return sendError(res, 500, "Internal server error"); }
}
function serveStatic(req, res) {
  const requested = req.url === "/" ? "/index.html" : req.url;
  const file = path.join(__dirname, "public", path.normalize(requested).replace(/^(\.\.[\\/])+/, ""));
  if (!file.startsWith(path.join(__dirname, "public"))) return sendError(res, 403, "Forbidden");
  fs.readFile(file, (err, data) => {
    if (err) return sendError(res, 404, "Not found");
    const type = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "text/html";
    res.writeHead(200, { "Content-Type": type }); res.end(data);
  });
}
const server = http.createServer(api);
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  if (parsed.pathname !== "/ws") return socket.destroy();
  const user = currentUser(req), tenantId = parsed.searchParams.get("tenant_id");
  if (!canAccess(user, tenantId)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, client => {
    client.tenantId = tenantId; client.user = user;
    if (!sockets.has(tenantId)) sockets.set(tenantId, new Set());
    sockets.get(tenantId).add(client);
    client.on("message", raw => {
      try {
        const message = JSON.parse(raw);
        if (message.type === "presence") broadcast(tenantId, { type: "presence", user: { id: user.id, name: user.name }, state: message.state }, client);
      } catch { client.send(JSON.stringify({ type: "error", message: "Invalid WebSocket message" })); }
    });
    client.on("close", () => { sockets.get(tenantId)?.delete(client); broadcast(tenantId, { type: "presence", user: { id: user.id, name: user.name }, state: "offline" }, client); });
    client.send(JSON.stringify({ type: "connected", user: { id: user.id, name: user.name }, tenant_id: tenantId }));
  });
});
server.listen(PORT, () => console.log(`Kanban board running at http://localhost:${PORT}`));
