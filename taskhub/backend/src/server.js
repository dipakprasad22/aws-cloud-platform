// src/server.js
// Express application entry point: middleware, routes, health check, error handling.
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const auth = require("./middleware/auth");
const authRoutes = require("./routes/auth");
const projectRoutes = require("./routes/projects");
const taskRoutes = require("./routes/tasks");
const { initPool } = require("./db/pool");

const app = express();
app.use(cors());
app.use(express.json());

// Health check for the ALB target group (deep: confirms the app is up)
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Public auth routes
app.use("/api/auth", authRoutes);

// Protected routes (require a valid JWT)
app.use("/api/projects", auth, projectRoutes);
app.use("/api/projects", auth, taskRoutes); // nested /:projectId/tasks

// 404 + error handlers
app.use((req, res) => res.status(404).json({ error: "route not found" }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: "internal error" }); });

const PORT = process.env.PORT || 3000;
initPool()
  .then(() => app.listen(PORT, () => console.log(`TaskHub API listening on ${PORT}`)))
  .catch((e) => { console.error("Failed to init DB pool:", e.message); process.exit(1); });
