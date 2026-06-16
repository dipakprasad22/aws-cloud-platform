// src/routes/auth.js
// Register and login. Passwords are hashed with bcrypt; a JWT is issued on success.
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { query } = require("../db/pool");

const router = express.Router();
const SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

function isEmail(s) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s); }

// POST /api/auth/register
router.post("/register", async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: "email, password, name required" });
  if (!isEmail(email)) return res.status(400).json({ error: "invalid email" });
  if (password.length < 8) return res.status(400).json({ error: "password must be at least 8 characters" });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await query(
      "INSERT INTO users (email, password, name) VALUES ($1,$2,$3) RETURNING id, email, name",
      [email.toLowerCase(), hash, name]
    );
    const user = r.rows[0];
    const token = jwt.sign({ sub: user.id }, SECRET, { expiresIn: "12h" });
    res.status(201).json({ token, user });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "email already registered" });
    console.error(e); res.status(500).json({ error: "registration failed" });
  }
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  try {
    const r = await query("SELECT id, email, name, password FROM users WHERE email=$1", [email.toLowerCase()]);
    const user = r.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "invalid credentials" });
    }
    const token = jwt.sign({ sub: user.id }, SECRET, { expiresIn: "12h" });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (e) {
    console.error(e); res.status(500).json({ error: "login failed" });
  }
});

module.exports = router;
