require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const { clerkMiddleware, requireAuth } = require("@clerk/express");
const { clerkClient } = require("@clerk/clerk-sdk-node");
const cors = require("cors");

const app = express();
app.use(express.json());

// Only use Clerk middleware in non-test environments
if (process.env.NODE_ENV !== "test") {
  app.use(clerkMiddleware());
}

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:3001",
      "https://sdp-frontend-production.up.railway.app",
    ],
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  })
);

// Database connection
const connectionString =
  process.env.NODE_ENV === "test"
    ? "postgres://postgres:postgres@localhost:5432/testdb"
    : process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10,
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

pool.on("connect", () => console.log("Database connected successfully"));
pool.on("error", (err) => console.error("Database connection error:", err));


// Utility: format interval[] for JSON response
function formatTimespan(timespan) {
  if (!timespan) return "Unknown";

  // If already an array (somehow), just join them
  if (Array.isArray(timespan))
    return timespan.map((ts) => ts.trim()).join(", ");

  // If string from Postgres array: "{01:30:00,02:15:00}"
  const cleaned = timespan.replace(/[{}]/g, ""); // remove {}
  const parts = cleaned.split(",").map((ts) => ts.trim());
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
const hikeTimers = {};
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
    const { rows } = await pool.query(
      "SELECT authid FROM usertable WHERE userid = $1",
      [uid]
    );
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
    const { rows } = await pool.query(
      `
      SELECT 
        ch.completedhikeid,
        ch.userid,
        ch.trailid,
        ch.date,
        ch.timespan::text AS timespan,
        t.name,
        t.location,
        t.difficulty,
        t.duration::text AS duration,  -- << convert interval to string
        t.description
      FROM completed_hike_table ch
      JOIN trail_table t ON ch.trailid = t.trailid
      WHERE ch.userid = $1
      ORDER BY ch.completedhikeid ASC
    `,
      [userId]
    );

    const formattedRows = rows.map((r) => ({
      ...r,
      timespan: formatTimespan(r.timespan),
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
    const { rows } = await pool.query(
      `
      SELECT 
        p.plannerid,
        p.trailid,
        p.planned_at,
        p.has_started,
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
    `,
      [userId]
    );
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
    return res
      .status(400)
      .json({ error: "Missing completedHikeId or timespan" });

  try {
    const timespanValue = Array.isArray(timespan) ? timespan[0] : timespan;
    await pool.query(
      `
      UPDATE completed_hike_table
      SET timespan = $1::interval
      WHERE completedhikeid = $2
    `,
      [timespanValue, completedHikeId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Update timespan error:", err.message);
    res.status(500).json({ error: "Failed to update timespan" });
  }
});

app.post("/update-planned-time", async (req, res) => {
  const { plannerId, plannedTime } = req.body;
  if (!plannerId || !plannedTime)
    return res.status(400).json({ error: "Missing plannerId or plannedTime" });

  try {
    await pool.query(
      `
      UPDATE planner_table
      SET planned_at = $1::timestamp
      WHERE plannerid = $2
    `,
      [plannedTime, plannerId]
    );

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
    const { rows } = await pool.query(
      "SELECT * FROM trail_table ORDER BY trailid ASC"
    );
    res.json({ trails: rows });
  } catch (err) {
    console.error("Fetch trails error:", err.message);
    res.status(500).json({ error: "Failed to fetch trails" });
  }
});

// Plan hike
// Plan hike
app.post("/plan-hike", async (req, res) => {
  const { trailId, plannedAt, userId, invitedFriends } = req.body;
  if (!trailId || !plannedAt || !userId)
    return res
      .status(400)
      .json({ error: "Missing trailId, plannedAt, or userId" });

  try {
    // Insert into planner_table including 'madeby'
    const plannerRes = await pool.query(
      `INSERT INTO planner_table (trailid, planned_at, madeby) 
       VALUES ($1, $2, $3) RETURNING plannerid`,
      [trailId, plannedAt, userId] // userId is the person planning the hike
    );

    const newPlannerId = plannerRes.rows[0].plannerid;

    // Insert the planner's own participation into 'hike' table
    await pool.query(
      "INSERT INTO hike (plannerid, userid, iscoming) VALUES ($1, $2, true)",
      [newPlannerId, userId]
    );

    // Insert invited friends if any
    if (Array.isArray(invitedFriends) && invitedFriends.length > 0) {
      const values = invitedFriends
        .map((id) => `(${newPlannerId}, ${id}, false)`)
        .join(",");
      await pool.query(
        `INSERT INTO hike (plannerid, userid, iscoming) VALUES ${values}`
      );
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

    const mutualIds = mutualRes.rows.map((u) => u.mutualid);

    const userData = await getUserData(mutualIds);

    const mutualFriends = mutualIds.map((id) => ({
      id,
      name: userData[id]?.username || `User ${id}`,
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
        p.madeby,
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
    await pool.query(`UPDATE hike SET iscoming = true WHERE hikeid = $1`, [
      hikeId,
    ]);
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
    await pool.query(`DELETE FROM hike WHERE hikeid = $1`, [hikeId]);
    res.json({ success: true });
  } catch (err) {
    console.error("Error declining hike:", err.message);
    res.status(500).json({ error: "Failed to decline hike" });
  }
});

// --- Start a hike (records start time) ---
// --- Start a hike (records start time) ---
app.post("/start-hike", async (req, res) => {
  const { plannerId, userId } = req.body;
  if (!plannerId || !userId)
    return res.status(400).json({ error: "Missing plannerId or userId" });

  try {
    // 1. Get planner info (trail duration and started_at)
    const { rows } = await pool.query(
      `
      SELECT t.duration::text AS duration, p.has_started
      FROM planner_table p
      JOIN trail_table t ON t.trailid = p.trailid
      WHERE p.plannerid = $1
    `,
      [plannerId]
    );

    if (!rows[0])
      return res.status(404).json({ error: "Planner or trail not found" });

    if (rows[0].has_started) {
      return res.status(400).json({ error: "Hike already started" });
    }

    const duration = rows[0].duration; // e.g., '02:30:00'

    // 2. Start hike: record start time and mark as started
    await pool.query(
      `
      UPDATE planner_table
      SET planned_at = NOW(), has_started = true
      WHERE plannerid = $1
    `,
      [plannerId]
    );

    // 3. Set a timeout to auto-stop hike
    const [hours, minutes, seconds] = duration.split(":").map(Number);
    const ms = ((hours * 60 + minutes) * 60 + seconds) * 1000;

    const timeoutId = setTimeout(async () => {
      try {
        const client = await pool.connect();
        await client.query("BEGIN");

        const { rows: plannerRows } = await client.query(
          "SELECT * FROM planner_table WHERE plannerid = $1",
          [plannerId]
        );
        if (!plannerRows[0]) throw new Error("Planner not found");

        const planner = plannerRows[0];

        await client.query(
          `INSERT INTO completed_hike_table (userid, trailid, date, timespan)
          VALUES ($1, $2, NOW(), $3::interval)`,
          [userId, planner.trailid, duration]
        );

        await client.query("DELETE FROM hike WHERE plannerid = $1", [
          plannerId,
        ]);
        await client.query("DELETE FROM planner_table WHERE plannerid = $1", [
          plannerId,
        ]);

        await client.query("COMMIT");
        client.release();
        console.log(`Auto-stopped hike ${plannerId} for user ${userId}`);

        // Remove from timers
        delete hikeTimers[plannerId];
      } catch (err) {
        console.error("Auto-stop hike error:", err);
      }
    }, ms);
    hikeTimers[plannerId] = timeoutId;
    res.json({
      success: true,
      planned_at: new Date().toISOString(),
      has_started: true,
      message: `Hike started, will auto-stop in ${duration}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to start hike" });
  }
});

// --- Stop hike / calculate timespan ---
// Stop hike route
app.post("/stop-hike", async (req, res) => {
  const { plannerId, userId } = req.body;
  if (!plannerId || !userId)
    return res.status(400).json({ error: "Missing plannerId or userId" });

  // Clear the auto-stop timer if it exists
  if (hikeTimers[plannerId]) {
    clearTimeout(hikeTimers[plannerId]);
    delete hikeTimers[plannerId];
    console.log(
      `Manual stop: cleared auto-stop timer for planner ${plannerId}`
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: plannerRows } = await client.query(
      "SELECT * FROM planner_table WHERE plannerid = $1",
      [plannerId]
    );

    if (plannerRows.length === 0) throw new Error("Planner entry not found");

    const planner = plannerRows[0];

    if (!planner.has_started) throw new Error("Hike has not been started");

    const { rows: durationRows } = await client.query(
      "SELECT NOW() - $1::timestamp AS timespan",
      [planner.planned_at]
    );

    const timespan = durationRows[0].timespan;

    const { rows: completedRows } = await client.query(
      `INSERT INTO completed_hike_table (userid, trailid, date, timespan)
       VALUES ($1, $2, NOW(), $3::interval)
       RETURNING completedhikeid`,
      [userId, planner.trailid, timespan]
    );

    const completedHikeId = completedRows[0].completedhikeid;

    await client.query(
      "DELETE FROM hike WHERE plannerid = $1 AND userid = $2",
      [plannerId, userId]
    );

    const { rows: remaining } = await client.query(
      "SELECT COUNT(*) FROM hike WHERE plannerid = $1",
      [plannerId]
    );

    if (parseInt(remaining[0].count, 10) === 0) {
      await client.query("DELETE FROM planner_table WHERE plannerid = $1", [
        plannerId,
      ]);
    }

    await client.query("COMMIT");

    res.json({ success: true, completedHikeId, timespan });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Stop hike error:", err.message);
    res.status(500).json({ error: "Failed to stop hike" });
  } finally {
    client.release();
  }
});

async function getFriends(userId) {
  // Step 1: fetch all the ids this user follows
  const { rows } = await pool.query(
    'SELECT "userID2" FROM follow_table WHERE "userID1" = $1',
    [userId]
  );

  const uidArr = rows.map((r) => r.userID2);

  if (uidArr.length === 0) {
    return []; // no friends
  }

  // Step 2: call your helper to enrich with Clerk user data
  const userDatas = await getUserData(uidArr);

  // Step 3: format into a friends list
  const friends = uidArr.map((uid) => ({
    id: uid,
    firstName: userDatas[uid].firstName,
    lastName: userDatas[uid].lastName,
    username: userDatas[uid].username,
    imageUrl: userDatas[uid].imageUrl,
  }));

  return friends;
}

app.get("/profile/:id/friends", async (req, res) => {
  try {
    const userId = req.params.id;
    const friends = await getFriends(userId);
    res.json(friends);
  } catch (err) {
    console.error("Error fetching friends:", err);
    res.status(500).json({ error: "Failed to fetch friends" });
  }
});

app.get("/profile/goals/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await pool.query(
      `SELECT gid AS id, name AS title, description, done
       FROM goal_table
       WHERE userid = $1 AND done = false`,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching personal goals:", err);
    res.status(500).json({ error: "Failed to fetch personal goals" });
  }
});
app.get("/profile/global-goals/:userId", async (req, res) => {
  const userId = req.params.userId;

  try {
    const sql = `
      SELECT a.achievementid AS id,
             a.name AS title,
             a.description,
             a.finishnumber AS target,
             COALESCE(u.currentnumber, 0) AS current
      FROM achievements_table a
      LEFT JOIN achievementsuserid_table u
             ON a.achievementid = u.achievementid
             AND u.userid = $1
      WHERE COALESCE(u.currentnumber, 0) < a.finishnumber;
    `;

    const result = await pool.query(sql, [userId]);

    const goals = result.rows.map((g) => ({
      id: g.id,
      title: g.title,
      description: g.description,
      target: Number(g.target),
      current: Number(g.current),
      source: "global",
    }));

    res.json(goals);
  } catch (err) {
    console.error("Error fetching global goals:", err);
    res.status(500).json({ error: "Failed to fetch global goals" });
  }
});

app.get("/profile/completed-hikes/:id", async (req, res) => {
  const userId = req.params.id;

  try {
    const hikesQuery = `
      SELECT * FROM completed_hike_table WHERE userid = $1
    `;
    const trailsQuery = `
      SELECT * FROM trail_table
    `;

    const [hikesRes, trailsRes] = await Promise.all([
      pool.query(hikesQuery, [userId]),
      pool.query(trailsQuery),
    ]);

    res.json({
      completed_hike_table: hikesRes.rows,
      trail: trailsRes.rows,
    });
  } catch (err) {
    console.error("Error fetching completed hikes:", err);
    res.status(500).json({ error: "Failed to fetch completed hikes" });
  }
});

// Get completed global achievements for a user
app.get("/completed-global/:id", async (req, res) => {
  const userId = req.params.id;

  try {
    const sql = `
      SELECT a.achievementid AS id,
             a.name AS title,
             a.description,
             a.finishnumber AS target,
             u.currentnumber AS current
      FROM achievements_table a
      JOIN achievementsuserid_table u
        ON a.achievementid = u.achievementid
      WHERE u.userid = $1
        AND u.currentnumber >= a.finishnumber
    `;

    const result = await pool.query(sql, [userId]);

    res.json({ rows: result.rows });
  } catch (err) {
    console.error("Error fetching completed global achievements:", err);
    res
      .status(500)
      .json({ error: "Failed to fetch completed global achievements" });
  }
});

app.get("/profile/completed-global/:id", async (req, res) => {
  const userId = req.params.id;

  if (!userId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  try {
    const query = `
      SELECT a.achievementid AS id,
             a.name AS title,
             a.description,
             a.finishnumber AS target,
             u.currentnumber AS current
      FROM achievements_table a
      JOIN achievementsuserid_table u
        ON a.achievementid = u.achievementid
      WHERE u.userid = $1 AND u.currentnumber >= a.finishnumber;
    `;

    const result = await pool.query(query, [userId]);

    const goals = result.rows.map((g) => ({
      id: g.id,
      title: g.title,
      description: g.description,
      target: Number(g.target),
      current: Number(g.current),
      source: "global",
    }));

    res.json({ goals });
  } catch (err) {
    console.error("Error fetching completed global goals:", err);
    res.status(500).json({ error: "Failed to fetch completed global goals" });
  }
});

app.get("/profile/completed-personal/:id", async (req, res) => {
  const userId = req.params.id;

  if (!userId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  try {
    const query = `
      SELECT gid AS id,
             name AS title,
             description,
             done
      FROM goal_table
      WHERE userid = $1 AND done = true;
    `;

    const result = await pool.query(query, [userId]);

    const goals = result.rows.map((g) => ({
      id: g.id,
      title: g.title,
      description: g.description,
      current: g.done ? 1 : 0, // for progress bar
      target: 1, // always 1 for personal goals
      done: g.done,
      source: "personal",
    }));

    res.json({ goals });
  } catch (err) {
    console.error("Error fetching completed personal goals:", err);
    res.status(500).json({ error: "Failed to fetch completed personal goals" });
  }
});

app.post("/profile/add-goal/:id", async (req, res) => {
  const userId = req.params.id;
  const { title, description } = req.body;

  if (!title || !description) {
    return res
      .status(400)
      .json({ error: "Title and description are required" });
  }

  try {
    const query = `
      INSERT INTO goal_table (userid, name, description, done)
      VALUES ($1, $2, $3, false)
      RETURNING gid AS id, name AS title, description, done;
    `;

    const result = await pool.query(query, [userId, title, description]);

    const savedGoal = result.rows[0];

    const formattedGoal = {
      id: savedGoal.id,
      title: savedGoal.title,
      description: savedGoal.description,
      current: 0,
      target: 1,
      done: savedGoal.done,
      source: "personal",
    };

    res.json({ goal: formattedGoal });
  } catch (err) {
    console.error("Error adding goal:", err);
    res.status(500).json({ error: "Failed to add goal" });
  }
});

app.put("/profile/edit-goal/:goalId/:id", async (req, res) => {
  const userId = req.params.id;
  const goalId = req.params.goalId;
  const { title, description } = req.body;

  if (!title?.trim() || !description?.trim()) {
    return res
      .status(400)
      .json({ error: "Title and description cannot be empty." });
  }

  try {
    const query = `
      UPDATE goal_table
      SET name = $1, description = $2
      WHERE gid = $3 AND userid = $4
      RETURNING gid AS id, name AS title, description, done;
    `;

    const result = await pool.query(query, [
      title,
      description,
      goalId,
      userId,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Goal not found" });
    }

    res.json({ goal: result.rows[0] });
  } catch (err) {
    console.error("Error updating goal:", err);
    res.status(500).json({ error: "Failed to update goal" });
  }
});

// DELETE a personal goal
app.delete("/profile/edit-goal/:goalId/:userId", async (req, res) => {
  const { goalId, userId } = req.params;

  try {
    const { rows } = await pool.query(
      `DELETE FROM goal_table 
       WHERE gid = $1 AND userid = $2
       RETURNING gid`,
      [goalId, userId]
    );

    if (rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Goal not found or not owned by user" });
    }

    res.json({ deletedGoalId: rows[0].gid });
  } catch (err) {
    console.error("Error deleting goal:", err);
    res.status(500).json({ error: "Failed to delete goal" });
  }
});
// MARK A PERSONAL GOAL AS DONE
app.put("/profile/mark-done/:goalId/:userId", async (req, res) => {
  const { goalId, userId } = req.params;

  try {
    const query = `
      UPDATE goal_table
      SET done = true
      WHERE gid = $1 AND userid = $2
      RETURNING gid AS id, name AS title, description, done;
    `;

    const result = await pool.query(query, [goalId, userId]);

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Goal not found or not owned by user" });
    }

    const updatedGoal = result.rows[0];

    res.json({
      message: "Goal marked as done",
      goal: {
        id: updatedGoal.id,
        title: updatedGoal.title,
        description: updatedGoal.description,
        done: updatedGoal.done,
        current: updatedGoal.done ? 1 : 0,
        target: 1,
        source: "personal",
      },
    });
  } catch (err) {
    console.error("Error marking goal as done:", err);
    res.status(500).json({ error: "Failed to mark goal as done" });
  }
});

app.get("/users/search", async (req, res) => {
  const { username } = req.query;

  if (!username) {
    return res.status(400).json({ error: "Username query is required" });
  }

  try {
    // Fetch all users (or with limit) from Clerk whose username matches
    const clerkUsers = await clerkClient.users.getUserList({
      limit: 20,
      query: username, // Clerk searches by username or email
    });

    // Enrich with your internal user ids
    const users = await Promise.all(
      clerkUsers
        .filter((u) => u.username?.toLowerCase() === username.toLowerCase())
        .map(async (user) => {
          const { rows } = await pool.query(
            "SELECT userid FROM usertable WHERE authid = $1",
            [user.id]
          );
          const internalId = rows[0]?.userid;

          return {
            id: internalId,
            username: user.username,
            imageUrl: user.imageUrl,
          };
        })
    );

    res.json({ users });
  } catch (err) {
    console.error("Error searching users:", err);
    res.status(500).json({ error: "Failed to search users" });
  }
});

// GET /users/random?limit=10
app.get("/users/random", async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const currentUserId = req.query.currentUserId; // pass logged-in user's ID from frontend

  if (!currentUserId) {
    return res.status(400).json({ error: "currentUserId is required" });
  }

  try {
    // Step 1: get IDs the user already follows
    const { rows: followingRows } = await pool.query(
      `SELECT "userID2" FROM follow_table WHERE "userID1" = $1`,
      [currentUserId]
    );
    const followingIds = followingRows.map((r) => r.userID2);

    // Step 2: add current user to exclusion list
    const excludeIds = [currentUserId, ...followingIds];

    // Step 3: fetch random users excluding current user and already-followed users
    const { rows } = await pool.query(
      `SELECT authid, userid 
       FROM usertable 
       WHERE userid != ALL($1::int[])
       ORDER BY RANDOM() 
       LIMIT $2`,
      [excludeIds, limit]
    );

    // Step 4: fetch Clerk data
    const users = [];
    for (const row of rows) {
      try {
        const user = await clerkClient.users.getUser(row.authid);
        users.push({
          id: row.userid,
          username: user.username,
          firstName: user.firstName,
          lastName: user.lastName,
          imageUrl: user.imageUrl,
        });
      } catch (err) {
        console.error(`Error fetching Clerk user ${row.authid}:`, err);
      }
    }

    res.json({ users });
  } catch (err) {
    console.error("Error fetching random users:", err);
    res.status(500).json({ error: "Failed to fetch random users" });
  }
});

app.post("/follow/:id", async (req, res) => {
  const followerId = req.body.followerId; // logged-in user's internal ID
  const followeeId = parseInt(req.params.id);

  if (!followerId || !followeeId) {
    return res
      .status(400)
      .json({ error: "Follower and followee IDs required" });
  }

  if (followerId === followeeId) {
    return res.status(400).json({ error: "Cannot follow yourself" });
  }

  try {
    const { rows: existing } = await pool.query(
      `SELECT * FROM follow_table WHERE "userID1" = $1 AND "userID2" = $2`,
      [followerId, followeeId]
    );

    if (existing.length > 0) {
      return res.status(400).json({ error: "Already following this user" });
    }

    const { rows } = await pool.query(
      `INSERT INTO follow_table ("userID1", "userID2") VALUES ($1, $2) RETURNING *`,
      [followerId, followeeId]
    );

    res.json({ message: "Followed successfully", follow: rows[0] });
  } catch (err) {
    console.error("Error following user:", err);
    res.status(500).json({ error: "Failed to follow user" });
  }
});

app.delete("/follow/:id", async (req, res) => {
  const followerId = req.body.followerId; // logged-in user's internal ID
  const followeeId = parseInt(req.params.id); // user to unfollow

  if (!followerId || !followeeId) {
    return res
      .status(400)
      .json({ error: "Follower and followee IDs required" });
  }

  try {
    const { rows } = await pool.query(
      `DELETE FROM follow_table 
       WHERE "userID1" = $1 AND "userID2" = $2
       RETURNING *`,
      [followerId, followeeId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Follow relationship not found" });
    }

    res.json({ message: "Unfollowed successfully", follow: rows[0] });
  } catch (err) {
    console.error("Error unfollowing user:", err);
    res.status(500).json({ error: "Failed to unfollow user" });
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
