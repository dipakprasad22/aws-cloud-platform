// src/routes/tasks.js
// CRUD for tasks within a project. Ownership is verified by joining through projects to req.userId.
const express = require("express");
const { query } = require("../db/pool");
const router = express.Router();

const STATUS = ["todo", "in_progress", "done"];
const PRIORITY = ["low", "medium", "high"];

// Helper: confirm the project belongs to the user
async function ownsProject(userId, projectId) {
  const r = await query("SELECT id FROM projects WHERE id=$1 AND user_id=$2", [projectId, userId]);
  return !!r.rows[0];
}

// GET /api/projects/:projectId/tasks
router.get("/:projectId/tasks", async (req, res) => {
  if (!(await ownsProject(req.userId, req.params.projectId))) return res.status(404).json({ error: "project not found" });
  const r = await query("SELECT id, title, status, priority, due_date, created_at FROM tasks WHERE project_id=$1 ORDER BY created_at DESC", [req.params.projectId]);
  res.json(r.rows);
});

// POST /api/projects/:projectId/tasks
router.post("/:projectId/tasks", async (req, res) => {
  if (!(await ownsProject(req.userId, req.params.projectId))) return res.status(404).json({ error: "project not found" });
  const { title, status, priority, due_date } = req.body || {};
  if (!title) return res.status(400).json({ error: "title required" });
  if (status && !STATUS.includes(status)) return res.status(400).json({ error: "invalid status" });
  if (priority && !PRIORITY.includes(priority)) return res.status(400).json({ error: "invalid priority" });
  const r = await query(
    "INSERT INTO tasks (project_id, title, status, priority, due_date) VALUES ($1,$2,$3,$4,$5) RETURNING id, title, status, priority, due_date, created_at",
    [req.params.projectId, title, status || "todo", priority || "medium", due_date || null]
  );
  res.status(201).json(r.rows[0]);
});

// PUT /api/projects/:projectId/tasks/:taskId
router.put("/:projectId/tasks/:taskId", async (req, res) => {
  if (!(await ownsProject(req.userId, req.params.projectId))) return res.status(404).json({ error: "project not found" });
  const { title, status, priority, due_date } = req.body || {};
  if (status && !STATUS.includes(status)) return res.status(400).json({ error: "invalid status" });
  if (priority && !PRIORITY.includes(priority)) return res.status(400).json({ error: "invalid priority" });
  const r = await query(
    `UPDATE tasks SET title=COALESCE($1,title), status=COALESCE($2,status),
       priority=COALESCE($3,priority), due_date=COALESCE($4,due_date)
     WHERE id=$5 AND project_id=$6 RETURNING id, title, status, priority, due_date, created_at`,
    [title || null, status || null, priority || null, due_date || null, req.params.taskId, req.params.projectId]
  );
  if (!r.rows[0]) return res.status(404).json({ error: "task not found" });
  res.json(r.rows[0]);
});

// DELETE /api/projects/:projectId/tasks/:taskId
router.delete("/:projectId/tasks/:taskId", async (req, res) => {
  if (!(await ownsProject(req.userId, req.params.projectId))) return res.status(404).json({ error: "project not found" });
  const r = await query("DELETE FROM tasks WHERE id=$1 AND project_id=$2 RETURNING id", [req.params.taskId, req.params.projectId]);
  if (!r.rows[0]) return res.status(404).json({ error: "task not found" });
  res.status(204).end();
});

module.exports = router;
