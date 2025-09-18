require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const { clerkMiddleware, requireAuth } = require("@clerk/express");
const { clerkClient } = require("@clerk/clerk-sdk-node");
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
    "http://localhost:3001",
    "https://sdp-frontend-production.up.railway.app"
  ],
  methods: ["GET", "POST"],
  credentials: true,
}));

// Database connection
const connectionString = process.env.NODE_ENV === 'test'
  ? 'postgres://postgres:postgres@localhost:5432/testdb'
  : process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10
});

pool.on('connect', () => console.log('Database connected successfully'));
pool.on('error', (err) => console.error('Database connection error:', err));

// Utility: format interval[] for JSON response
function formatTimespan(timespan) {
  if (!timespan) return "Unknown";

  // If already an array (somehow), just join them
  if (Array.isArray(timespan)) return timespan.map(ts => ts.trim()).join(", ");

  // If string from Postgres array: "{01:30:00,02:15:00}"
  const cleaned = timespan.replace(/[{}]/g, ""); // remove {}
  const parts = cleaned.split(",").map(ts => ts.trim());
  return parts.join(", ");
}


// Routes
app.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({ time: result.rows[0].now });
  } catch (error) {
    console.error("Database query error:", error);
    res.status(500).json({ error: "Database connection failed" });
  }
});

// Arbitrary SQL query (for testing)
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

// Fetch Clerk user info by array of user IDs
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
  for (const uid of uidArr) {
    const { rows } = await pool.query("SELECT authid FROM usertable WHERE userid = $1", [uid]);
    const authid = rows[0]?.authid;
    if (!authid) continue;
    const user = await clerkClient.users.getUser(authid);
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

// Completed hikes
app.get("/completed-hikes/:userId", async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  try {
    const { rows } = await pool.query(`
      SELECT 
        ch.completedhikeid,
        ch.userid,
        ch.trailid,
        ch.date,
        ch.timespan::text AS timespan,
        t.name,
        t.location,
        t.difficulty,
        t.duration,
        t.description
      FROM completed_hike_table ch
      JOIN trail_table t ON ch.trailid = t.trailid
      WHERE ch.userid = $1
      ORDER BY ch.completedhikeid ASC
    `, [userId]);

    const formattedRows = rows.map(r => ({
      ...r,
      timespan: formatTimespan(r.timespan)
    }));

    res.json({ rows: formattedRows });
  } catch (err) {
    console.error("Completed hikes query error:", err.message);
    res.status(500).json({ error: "Failed to fetch completed hikes" });
  }
});

// Upcoming hikes
app.get("/upcoming-hikes/:userId", async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  try {
    const { rows } = await pool.query(`
      SELECT 
        p.plannerid,
        p.trailid,
        p.planned_at,
        t.name,
        t.location,
        t.difficulty,
        t.duration,
        t.description
      FROM planner_table p
      JOIN hike h ON h.plannerid = p.plannerid
      JOIN trail_table t ON t.trailid = p.trailid
      WHERE h.userid = $1 AND h.iscoming = true
      ORDER BY p.planned_at ASC
    `, [userId]);
    res.json({ rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch upcoming hikes" });
  }
});

// Update completed hike timespan (FIXED)
app.post("/update-timespan", async (req, res) => {
  const { completedHikeId, timespan } = req.body;
  if (!completedHikeId || !timespan) 
    return res.status(400).json({ error: "Missing completedHikeId or timespan" });

  try {
    const timespanValue = Array.isArray(timespan) ? timespan[0] : timespan;
    await pool.query(`
      UPDATE completed_hike_table
      SET timespan = $1::interval
      WHERE completedhikeid = $2
    `, [timespanValue, completedHikeId]);
    res.json({ success: true });
  } catch (err) {
    console.error("Update timespan error:", err.message);
    res.status(500).json({ error: "Failed to update timespan" });
  }
});

// Update upcoming hike planned time
app.post("/update-planned-time", async (req, res) => {
  const { plannerId, plannedTime } = req.body;
  if (!plannerId || !plannedTime) return res.status(400).json({ error: "Missing plannerId or plannedTime" });
  try {
    await pool.query(`
      UPDATE planner_table
      SET planned_at = DATE(planned_at) + TIME $1
      WHERE plannerid = $2
    `, [plannedTime, plannerId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update planned time" });
  }
});

// Users
app.get("/user/:authID", async (req, res) => {
  const { authID } = req.params;
  try {
    const { rows } = await pool.query(
      "SELECT * FROM usertable WHERE authid = $1 LIMIT 1",
      [authID]
    );
    res.json({ user: rows[0] || null });
  } catch (err) {
    console.error("Get user error:", err.message);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

app.post("/user", async (req, res) => {
  const { authID, biography } = req.body;
  if (!authID) return res.status(400).json({ error: "authID is required" });
  try {
    const { rows } = await pool.query(
      "INSERT INTO usertable (authid, biography) VALUES ($1, $2) RETURNING *",
      [authID, biography || ""]
    );
    res.json({ user: rows[0] });
  } catch (err) {
    console.error("Create user error:", err.message);
    res.status(500).json({ error: "Failed to create user" });
  }
});

// Trails
app.get("/trails", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM trail_table ORDER BY trailid ASC");
    res.json({ trails: rows });
  } catch (err) {
    console.error("Fetch trails error:", err.message);
    res.status(500).json({ error: "Failed to fetch trails" });
  }
});

// Plan hike
app.post("/plan-hike", async (req, res) => {
  const { trailId, plannedAt, userId, invitedFriends } = req.body;
  if (!trailId || !plannedAt || !userId) return res.status(400).json({ error: "Missing trailId, plannedAt, or userId" });
  try {
    const plannerRes = await pool.query(
      "INSERT INTO planner_table (trailid, planned_at) VALUES ($1, $2) RETURNING plannerid",
      [trailId, plannedAt]
    );
    const newPlannerId = plannerRes.rows[0].plannerid;
    await pool.query("INSERT INTO hike (plannerid, userid, iscoming) VALUES ($1, $2, true)", [newPlannerId, userId]);

    if (Array.isArray(invitedFriends) && invitedFriends.length > 0) {
      const values = invitedFriends.map(id => `(${newPlannerId}, ${id}, false)`).join(",");
      await pool.query(`INSERT INTO hike (plannerid, userid, iscoming) VALUES ${values}`);
    }
    res.json({ success: true, plannerId: newPlannerId });
  } catch (err) {
    console.error("Plan hike error:", err.message);
    res.status(500).json({ error: "Failed to plan hike" });
  }
});

app.get("/friends/:userId", async (req, res) => {
  const userId = parseInt(req.params.userId, 10);

  try {
    const mutualRes = await pool.query(
      `
      SELECT f1."userID2" AS mutualid
      FROM follow_table f1
      JOIN follow_table f2 
        ON f1."userID2" = f2."userID1" 
       AND f2."userID2" = $1
      WHERE f1."userID1" = $1
      `,
      [userId]
    );

    const mutualIds = mutualRes.rows.map(u => u.mutualid);

    const userData = await getUserData(mutualIds);

    const mutualFriends = mutualIds.map(id => ({
      id,
      name: userData[id]?.username || `User ${id}`
    }));

    res.json({ friends: mutualFriends });
  } catch (err) {
    console.error("Fetch mutual friends error:", err.message);
    res.status(500).json({ error: "Failed to fetch friends" });
  }
});
// Get pending hikes for a user (iscoming = false)
app.get("/pending-hikes/:userId", async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  try {
    const result = await pool.query(
      `
      SELECT 
        h.hikeid,
        h.plannerid,
        p.trailid,
        p.planned_at,
        t.name,
        t.location,
        t.difficulty,
        t.duration,
        t.description
      FROM hike h
      JOIN planner_table p ON h.plannerid = p.plannerid
      JOIN trail_table t ON p.trailid = t.trailid
      WHERE h.userid = $1 AND h.iscoming = false
      ORDER BY p.planned_at ASC
      `,
      [userId]
    );
    res.json({ pendingHikes: result.rows });
  } catch (err) {
    console.error("Error fetching pending hikes:", err.message);
    res.status(500).json({ error: "Failed to fetch pending hikes" });
  }
});


// Accept an invite
app.post("/hike-accept", async (req, res) => {
  const { hikeId } = req.body;
  try {
    await pool.query(
      `UPDATE hike SET iscoming = true WHERE hikeid = $1`,
      [hikeId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Error accepting hike:", err.message);
    res.status(500).json({ error: "Failed to accept hike" });
  }
});

// Decline an invite
app.post("/hike-decline", async (req, res) => {
  const { hikeId } = req.body;
  try {
    await pool.query(
      `DELETE FROM hike WHERE hikeid = $1`,
      [hikeId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Error declining hike:", err.message);
    res.status(500).json({ error: "Failed to decline hike" });
  }
});


// Protected route
app.get("/protected", requireAuth(), async (req, res) => {
  const userId = req.auth.userId;
  res.json({ message: "You are logged in!", userId });
});

// Start server if not in test
if (process.env.NODE_ENV !== "test") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = { app, pool };
