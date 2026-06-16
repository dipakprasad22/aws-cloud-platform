// src/routes/projects.js
// CRUD for projects. Every query is scoped to req.userId so users only see their own data.
const express = require("express");
const { query } = require("../db/pool");
const router = express.Router();

// GET /api/projects
router.get("/", async (req, res) => {
  const r = await query("SELECT id, name, description, created_at FROM projects WHERE user_id=$1 ORDER BY created_at DESC", [req.userId]);
  res.json(r.rows);
});

// POST /api/projects
router.post("/", async (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const r = await query(
    "INSERT INTO projects (user_id, name, description) VALUES ($1,$2,$3) RETURNING id, name, description, created_at",
    [req.userId, name, description || null]
  );
  res.status(201).json(r.rows[0]);
});

// GET /api/projects/:id
router.get("/:id", async (req, res) => {
  const r = await query("SELECT id, name, description, created_at FROM projects WHERE id=$1 AND user_id=$2", [req.params.id, req.userId]);
  if (!r.rows[0]) return res.status(404).json({ error: "not found" });
  res.json(r.rows[0]);
});

// PUT /api/projects/:id
router.put("/:id", async (req, res) => {
  const { name, description } = req.body || {};
  const r = await query(
    "UPDATE projects SET name=COALESCE($1,name), description=COALESCE($2,description) WHERE id=$3 AND user_id=$4 RETURNING id, name, description, created_at",
    [name || null, description || null, req.params.id, req.userId]
  );
  if (!r.rows[0]) return res.status(404).json({ error: "not found" });
  res.json(r.rows[0]);
});

// DELETE /api/projects/:id  (tasks cascade-delete via FK)
router.delete("/:id", async (req, res) => {
  const r = await query("DELETE FROM projects WHERE id=$1 AND user_id=$2 RETURNING id", [req.params.id, req.userId]);
  if (!r.rows[0]) return res.status(404).json({ error: "not found" });
  res.status(204).end();
});

module.exports = router;
