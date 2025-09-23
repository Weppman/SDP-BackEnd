jest.setTimeout(60000);

// ------------------------
// 1. MOCK CLERK
// ------------------------
jest.mock("@clerk/clerk-sdk-node", () => ({
  clerkClient: {
    users: {
      getUser: jest.fn(async (authid) => {
        const users = {
          user_abc123: {
            id: authid,
            primaryEmailAddress: { emailAddress: "alice@example.com" },
            firstName: "Alice",
            lastName: "A",
            username: "alice123",
            imageUrl: "http://example.com/alice.png",
          },
          user_xyz456: {
            id: authid,
            primaryEmailAddress: { emailAddress: "bob@example.com" },
            firstName: "Bob",
            lastName: "B",
            username: "bob456",
            imageUrl: "http://example.com/bob.png",
          },
        };
        if (!users[authid]) throw new Error("User not found");
        return users[authid];
      }),
      getUserList: jest.fn(async ({ query }) => {
        const allUsers = [
          { id: "user_abc123", username: "alice123", imageUrl: "http://example.com/alice.png" },
          { id: "user_xyz456", username: "bob456", imageUrl: "http://example.com/bob.png" },
        ];
        
        if (query) {
          return allUsers.filter(u => u.username.toLowerCase().includes(query.toLowerCase()));
        }
        return allUsers;
      }),
    },
  },
}));

// ------------------------
// 2. IMPORT SERVER
// ------------------------
const request = require("supertest");
const { app, pool } = require("../server");
const { clerkClient } = require("@clerk/clerk-sdk-node");

const API_KEY = "1234asdf";
const authRequest = (r) => r.set("x-api-key", API_KEY);

// ------------------------
// 3. MOCK DATABASE
// ------------------------
beforeEach(() => {
  pool.query = jest.fn(async (sql, params) => {
    const sqlLower = sql.toLowerCase();
    
    // API key check
    if (sql.includes("FROM api_table")) {
      return params[0] === API_KEY
        ? { rows: [{ userid: 999 }] }
        : { rows: [] };
    }

    // Current timestamp
    if (sql.includes("SELECT NOW()")) {
      return { rows: [{ now: new Date().toISOString() }] };
    }

    // Auth ID lookup from usertable (not users_table)
    if (sql.includes("SELECT authid FROM usertable")) {
      if (params[0] === "1") return { rows: [{ authid: "user_abc123" }] };
      if (params[0] === "2") return { rows: [{ authid: "user_xyz456" }] };
      return { rows: [] };
    }

    // User lookup by authid
    if (sql.includes("SELECT userid FROM usertable WHERE authid")) {
      if (params[0] === "user_abc123") return { rows: [{ userid: 1 }] };
      if (params[0] === "user_xyz456") return { rows: [{ userid: 2 }] };
      return { rows: [] };
    }

    // Follow table operations
    if (sql.includes("FROM follow_table")) {
      if (sqlLower.includes("insert")) {
        // Check for existing follow relationship first
        return { rows: [{ userID1: params[0], userID2: params[1] }] };
      }
      if (sqlLower.includes("delete")) {
        return { rows: [{ userID1: params[0], userID2: params[1] }] };
      }
      if (sqlLower.includes("select") && sql.includes('"userID2"')) {
        // Friends lookup - user 1 follows user 2
        if (params[0] === "1") {
          return { rows: [{ userID2: "2" }] };
        }
      }
      // Check for existing follow relationship
      if (sqlLower.includes('select * from follow_table where "userid1"')) {
        return { rows: [] }; // No existing relationship for new follows
      }
      return { rows: [] };
    }

    // Personal goals from goal_table
    if (sql.includes("goal_table")) {
      // INSERT new goal
      if (sqlLower.includes("insert into goal_table")) {
        return { 
          rows: [{ 
            id: 101, 
            title: params[1], 
            description: params[2], 
            done: false 
          }] 
        };
      }
      
      // UPDATE goal - mark as done
      if (sqlLower.includes("update goal_table") && sqlLower.includes("set done = true")) {
        // Server query: UPDATE goal_table SET done = true WHERE gid = $1 AND userid = $2
        // params[0] = goalId, params[1] = userId
        if (params[0] === "101" && params[1] === "1") {
          return { 
            rows: [{ 
              id: 101, 
              title: "Personal Goal 1", 
              description: "Desc A", 
              done: true 
            }] 
          };
        }
        return { rows: [] }; // Goal not found
      }
      
      // UPDATE goal - edit title/description
      if (sqlLower.includes("update goal_table") && sqlLower.includes("set name")) {
        // Server query: UPDATE goal_table SET name = $1, description = $2 WHERE gid = $3 AND userid = $4
        // params[0] = title, params[1] = description, params[2] = goalId, params[3] = userId
        if (params[2] === "101" && params[3] === "1") {
          return { 
            rows: [{ 
              id: 101, 
              title: params[0], 
              description: params[1], 
              done: false 
            }] 
          };
        }
        return { rows: [] }; // Goal not found
      }
      
      // DELETE goal
      if (sqlLower.includes("delete from goal_table")) {
        // Server query: DELETE FROM goal_table WHERE gid = $1 AND userid = $2
        // params[0] = goalId, params[1] = userId
        if (params[0] === "101" && params[1] === "1") {
          return { rows: [{ gid: 101 }] };
        }
        return { rows: [] }; // Goal not found
      }
      
      // SELECT goals for user
      if (sqlLower.includes("select") && sqlLower.includes("where userid")) {
        if (params[0] === "1") {
          return {
            rows: [
              { id: 201, title: "Personal Goal 1", description: "Desc A", done: false },
              { id: 202, title: "Personal Goal 2", description: "Desc B", done: false },
            ],
          };
        }
        return { rows: [] };
      }
    }

    // Global goals/achievements
    if (sql.includes("achievements_table")) {
      return {
        rows: [
          { 
            id: 101, 
            title: "Global Goal 1", 
            description: "Global Desc 1", 
            target: 10, 
            current: 5,
            source: "global"
          },
          { 
            id: 102, 
            title: "Global Goal 2", 
            description: "Global Desc 2", 
            target: 20, 
            current: 8,
            source: "global"
          },
        ],
      };
    }

    // Completed hikes
    if (sql.includes("FROM completed_hike_table")) {
      return { rows: [{ hikeId: 1, trailId: 101, date: "2025-09-20" }] };
    }

    // Trails
    if (sql.includes("FROM trail_table")) {
      return { rows: [{ trailId: 101, name: "Trail A" }] };
    }

    // Users table queries for search/random
    if (sql.includes("FROM usertable") && !sql.includes("WHERE authid")) {
      if (sqlLower.includes("order by random()")) {
        // Random users query
        return { 
          rows: [
            { authid: "user_abc123", userid: 1 },
            { authid: "user_xyz456", userid: 2 }
          ] 
        };
      }
      // Generic user table query
      return { rows: [{ userid: 1, authid: "user_abc123" }] };
    }

    // Generic check query
    if (sql.includes("SELECT 1")) return { rows: [{ num: 1 }] };

    return { rows: [] };
  });
});

// ------------------------
// 4. TEST SUITE
// ------------------------
describe("Express API", () => {
  afterAll(async () => await pool.end());

  test("GET / returns current time", async () => {
    const res = await authRequest(request(app).get("/"));
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty("time");
  });

  test("POST /query with missing SQL returns 400", async () => {
    const res = await authRequest(request(app).post("/query").send({}));
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty("error", "SQL query is required");
  });

  test("POST /query with valid SQL returns rows", async () => {
    const res = await authRequest(request(app).post("/query").send({ sql: "SELECT 1 as num" }));
    expect(res.statusCode).toBe(200);
    expect(res.body.rows[0]).toHaveProperty("num", 1);
  });

  test("POST /uid returns correct user data", async () => {
    const res = await authRequest(request(app).post("/uid").send({ uidArr: ["1", "2"] }));
    expect(res.statusCode).toBe(200);
    expect(res.body.userDatas["1"]).toMatchObject({
      id: "user_abc123",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "A",
      username: "alice123",
      imageUrl: "http://example.com/alice.png",
    });
    expect(res.body.userDatas["2"]).toMatchObject({
      id: "user_xyz456",
      email: "bob@example.com",
      firstName: "Bob",
      lastName: "B",
      username: "bob456",
      imageUrl: "http://example.com/bob.png",
    });
  });

  test("rejects requests with no or wrong API key", async () => {
    expect((await request(app).get("/")).statusCode).toBe(401);
    expect((await request(app).get("/").set("x-api-key", "wrong-key")).statusCode).toBe(403);
  });

  describe("Profile endpoints", () => {
    test("GET /profile/:id/friends returns friends", async () => {
      const res = await authRequest(request(app).get("/profile/1/friends"));
      expect(res.body[0]).toMatchObject({ id: "2", firstName: "Bob", lastName: "B" });
    });

    test("GET /profile/goals/:userId returns personal goals", async () => {
      const res = await authRequest(request(app).get("/profile/goals/1"));
      expect(res.body).toHaveLength(2);
    });

    test("GET /profile/global-goals/:userId returns global goals", async () => {
      const res = await authRequest(request(app).get("/profile/global-goals/1"));
      expect(res.body[0]).toHaveProperty("id", 101);
      expect(res.body[1]).toHaveProperty("id", 102);
    });

    test("GET /profile/completed-hikes/:id returns hikes and trails", async () => {
      const res = await authRequest(request(app).get("/profile/completed-hikes/1"));
      expect(res.body.completed_hike_table[0]).toHaveProperty("hikeId", 1);
      expect(res.body.trail[0]).toHaveProperty("trailId", 101);
    });
  });

  describe("Follow endpoints", () => {
    test("POST /follow/:id follows user", async () => {
      const res = await authRequest(request(app).post("/follow/2").send({ followerId: 1 }));
      expect(res.body).toHaveProperty("message", "Followed successfully");
    });

    test("DELETE /follow/:id unfollows user", async () => {
      const res = await authRequest(request(app).delete("/follow/2").send({ followerId: 1 }));
      expect(res.body).toHaveProperty("message", "Unfollowed successfully");
    });
  });

  describe("Goal modification endpoints", () => {
    test("PUT /profile/mark-done/:goalId/:userId marks goal", async () => {
      const res = await authRequest(request(app).put("/profile/mark-done/101/1"));
      expect(res.body).toHaveProperty("message", "Goal marked as done");
    });

    test("POST /profile/add-goal/:id adds goal", async () => {
      const res = await authRequest(
        request(app).post("/profile/add-goal/1").send({ title: "New Goal", description: "Do something" })
      );
      expect(res.body.goal).toHaveProperty("id", 101);
    });

    test("PUT /profile/edit-goal/:goalId/:id edits goal", async () => {
      const res = await authRequest(
        request(app).put("/profile/edit-goal/101/1").send({ title: "Updated Goal", description: "Updated description" })
      );
      expect(res.body.goal).toHaveProperty("id", 101);
    });

    test("DELETE /profile/edit-goal/:goalId/:userId deletes goal", async () => {
      const res = await authRequest(request(app).delete("/profile/edit-goal/101/1"));
      expect(res.body).toHaveProperty("deletedGoalId", 101);
    });
  });

  describe("Users endpoints", () => {
    test("GET /users/search returns users", async () => {
      const res = await authRequest(request(app).get("/users/search").query({ username: "alice123" }));
      expect(res.body.users[0]).toHaveProperty("id", 1);
    });

    test("GET /users/random returns random users", async () => {
      const res = await authRequest(request(app).get("/users/random?currentUserId=1&limit=2"));
      expect(res.body.users.length).toBeGreaterThan(0);
    });
  });
});