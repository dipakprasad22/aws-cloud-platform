// src/db/migrate.js
// Creates the schema: users -> projects -> tasks (one-to-many down the chain).
// Run once after the database is reachable:  npm run migrate
const { query, initPool } = require("./pool");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  email       VARCHAR(255) UNIQUE NOT NULL,
  password    VARCHAR(255) NOT NULL,
  name        VARCHAR(255) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       VARCHAR(255) NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'todo',  -- todo | in_progress | done
  priority    VARCHAR(20) NOT NULL DEFAULT 'medium', -- low | medium | high
  due_date    DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
`;

(async () => {
  try {
    await initPool();
    await query(SCHEMA);
    console.log("Migration complete: users, projects, tasks created.");
    process.exit(0);
  } catch (e) {
    console.error("Migration failed:", e.message);
    process.exit(1);
  }
})();
