require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const { clerkMiddleware, requireAuth } = require("@clerk/express");
const { clerkClient } = require ("@clerk/clerk-sdk-node");
const cors = require("cors");

const app = express();
app.use(express.json());

// Only use Clerk middleware in non-test environments
if (process.env.NODE_ENV !== 'test') {
  app.use(clerkMiddleware());
}

app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://sdp-frontend-production.up.railway.app"
  ],
  methods: ["GET", "POST"],
  credentials: true,
}));

// Use test database configuration when in test environment
const connectionString = process.env.NODE_ENV === 'test' 
  ? 'postgres://postgres:postgres@localhost:5432/testdb'
  : process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: connectionString,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10
});


async function apiKeyMiddleware(req, res, next) {
  const apiKey = req.headers["x-api-key"]; // read from header

  if (!apiKey) {
    return res.status(401).json({ error: "Missing API key" });
  }

  const { rows } = await pool.query(
    "SELECT key FROM api_table WHERE key = $1",
    [apiKey]
  );

  if (rows.length === 0) {
    return res.status(403).json({ error: "Invalid API key" });
  }

  // store user info for downstream routes
  req.userId = rows[0].userid;
  next();
}

app.use(apiKeyMiddleware);


// Test database connection on startup
pool.on('connect', (client) => {
  console.log('Database connected successfully');
});

pool.on('error', (err) => {
  console.error('Database connection error:', err);
});

app.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({ time: result.rows[0].now });
  } catch (error) {
    console.error("Database query error:", error);
    res.status(500).json({ error: "Database connection failed" });
  }
});

app.post("/query", async (req, res) => {
  const { sql } = req.body;

  if (!sql) return res.status(400).json({ error: "SQL query is required" });

  try {
    const result = await pool.query(sql);
    res.json({ rows: result.rows });
  } catch (error) {
    console.error("Query error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/uid", async (req, res) => {
  const { uidArr } = req.body;

  try {
    const data = await getUserData(uidArr);
    res.json({ userDatas: data });
  } catch (error) {
    console.error("Error fetching user data:", error);
    res.status(500).json({ error: "Failed to fetch user data" });
  }
});

async function getUserData(uidArr) {
  const userDatas = {};

  for (let i = 0; i < uidArr.length; i++) {
    const uid = uidArr[i];

    const { rows } = await pool.query("SELECT authid FROM usertable WHERE userid = $1", [uid]);
    const authid = rows[0]?.authid;

    console.error("Fetched authid:", authid);

    const user = await clerkClient.users.getUser(authid);

    console.error("Fetched user from Clerk:", user);

    userDatas[uid] = {
      id: user.id,
      email: user.primaryEmailAddress?.emailAddress,
      firstName: user.firstName,
      lastName: user.lastName,
      username: user.username,
      imageUrl: user.imageUrl,
    };
  }

  return userDatas;
}




app.get("/protected", requireAuth(), async (req, res) => {
  const userId = req.auth.userId;
  res.json({ message: "You are logged in!", userId });
});


if (process.env.NODE_ENV !== "test") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = { app, pool };