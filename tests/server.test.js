jest.setTimeout(60000); // 60 seconds for all tests

// ------------------------
// 1. MOCK CLERK BEFORE SERVER IMPORT
// ------------------------
jest.mock("@clerk/clerk-sdk-node", () => {
  return {
    clerkClient: {
      users: {
        getUser: jest.fn(async (authid) => {
          if (authid === "user_abc123")
            return {
              id: authid,
              primaryEmailAddress: { emailAddress: "alice@example.com" },
              firstName: "Alice",
              lastName: "A",
              username: "alice123",
              imageUrl: "http://example.com/alice.png",
            };
          if (authid === "user_xyz456")
            return {
              id: authid,
              primaryEmailAddress: { emailAddress: "bob@example.com" },
              firstName: "Bob",
              lastName: "B",
              username: "bob456",
              imageUrl: "http://example.com/bob.png",
            };
          throw new Error("User not found");
        }),
      },
    },
  };
});
// ------------------------
// 1. MOCK CLERK BEFORE SERVER IMPORT
// ------------------------
jest.mock("@clerk/clerk-sdk-node", () => ({
  clerkClient: {
    users: {
      // existing getUser mock
      getUser: jest.fn(async (authid) => {
        if (authid === "user_abc123")
          return {
            id: authid,
            primaryEmailAddress: { emailAddress: "alice@example.com" },
            firstName: "Alice",
            lastName: "A",
            username: "alice123",
            imageUrl: "http://example.com/alice.png",
          };
        if (authid === "user_xyz456")
          return {
            id: authid,
            primaryEmailAddress: { emailAddress: "bob@example.com" },
            firstName: "Bob",
            lastName: "B",
            username: "bob456",
            imageUrl: "http://example.com/bob.png",
          };
        throw new Error("User not found");
      }),
      // 👈 Add getUserList here
      getUserList: jest.fn(),
    },
  },
}));

// ------------------------
// 2. IMPORT SERVER AFTER MOCK
// ------------------------
const request = require("supertest");
const { app, pool } = require("../server");
const { clerkClient } = require("@clerk/clerk-sdk-node");

// API key we expect
const API_KEY = "1234asdf";

// ------------------------
// 3. MOCK DATABASE
// ------------------------
beforeAll(() => {
  pool.query = jest.fn((sql, params) => {
    // Mock GET /
    if (sql.includes("SELECT NOW()")) {
      return { rows: [{ now: new Date().toISOString() }] };
    }

    // Mock /uid endpoint
    if (sql.includes("SELECT authid")) {
      const uid = params[0];
      if (uid === "1") return { rows: [{ authid: "user_abc123" }] };
      if (uid === "2") return { rows: [{ authid: "user_xyz456" }] };
      return { rows: [] };
    }

    // Mock /query endpoint
    if (sql.includes("SELECT 1")) return { rows: [{ num: 1 }] };

    // Mock api key check
    if (sql.includes("FROM api_table")) {
      if (params[0] === API_KEY) return { rows: [{ userid: 999 }] }; // mock userId for key
      return { rows: [] }; // invalid key
    }

    return { rows: [] };
  });
});

// ------------------------
// 4. TEST SUITE
// ------------------------
describe("Express API", () => {
  afterAll(async () => {
    await pool.end();
  });

  test("GET / should return current time", async () => {
    const res = await request(app)
      .get("/")
      .set("x-api-key", API_KEY); // add API key
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty("time");
  });

  test("POST /query should return error if sql missing", async () => {
    const res = await request(app)
      .post("/query")
      .set("x-api-key", API_KEY) // add API key
      .send({});
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty("error", "SQL query is required");
  });

  test("POST /query should return rows for valid SQL", async () => {
    const res = await request(app)
      .post("/query")
      .set("x-api-key", API_KEY) // add API key

      .send({ sql: "SELECT 1 as num" });
    expect(res.statusCode).toBe(200);
    expect(res.body.rows[0]).toHaveProperty("num", 1);
  });

  test("POST /uid returns user data for valid uidArr", async () => {
    const res = await request(app)
      .post("/uid")

      .set("x-api-key", API_KEY) // add API key

      .send({ uidArr: ["1", "2"] });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty("userDatas");

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


  test("should reject requests with no API key", async () => {
    const res = await request(app).get("/");
    expect(res.statusCode).toBe(401);
    expect(res.body).toHaveProperty("error");
  });

  test("should reject requests with wrong API key", async () => {
    const res = await request(app).get("/").set("x-api-key", "wrong-key");
    expect(res.statusCode).toBe(403);
    expect(res.body).toHaveProperty("error");

  test("GET /profile/:id/friends returns enriched friends list", async () => {
    pool.query.mockImplementation((sql, params) => {
      if (sql.includes("FROM follow_table")) {
        return Promise.resolve({ rows: [{ userID2: "2" }] });
      }
      if (sql.includes("SELECT authid FROM usertable")) {
        if (params[0] === "2") {
          return Promise.resolve({ rows: [{ authid: "user_xyz456" }] });
        }
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app).get("/profile/1/friends");
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: "2",
      firstName: "Bob",
      lastName: "B",
      username: "bob456",
      imageUrl: "http://example.com/bob.png",
    });
  });
  test("GET /profile/goals/:userId returns personal goals", async () => {
    pool.query.mockImplementation((sql, params) => {
      if (sql.includes("FROM goal_table")) {
        return Promise.resolve({
          rows: [
            { id: 101, title: "Goal 1", description: "Desc 1", done: false },
            { id: 102, title: "Goal 2", description: "Desc 2", done: false },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app).get("/profile/goals/1");
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({
      id: 101,
      title: "Goal 1",
      description: "Desc 1",
      done: false,
    });
    expect(res.body[1]).toMatchObject({
      id: 102,
      title: "Goal 2",
      description: "Desc 2",
      done: false,
    });
  });
  test("GET /profile/global-goals/:userId returns global goals", async () => {
    pool.query.mockImplementation((sql, params) => {
      if (sql.includes("FROM achievements_table")) {
        return Promise.resolve({
          rows: [
            {
              id: 201,
              title: "Global Goal 1",
              description: "Complete 10 hikes",
              target: 10,
              current: 4,
            },
            {
              id: 202,
              title: "Global Goal 2",
              description: "Run 100km",
              target: 100,
              current: 20,
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app).get("/profile/global-goals/1");
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({
      id: 201,
      title: "Global Goal 1",
      description: "Complete 10 hikes",
      target: 10,
      current: 4,
      source: "global",
    });
    expect(res.body[1]).toMatchObject({
      id: 202,
      title: "Global Goal 2",
      description: "Run 100km",
      target: 100,
      current: 20,
      source: "global",
    });
  });
  test("GET /profile/completed-hikes/:id returns completed hikes and trails", async () => {
    pool.query.mockImplementation((sql, params) => {
      if (sql.includes("FROM completed_hike_table")) {
        return Promise.resolve({
          rows: [
            { hikeId: 1, userid: "1", trailId: 101, date: "2025-09-20" },
            { hikeId: 2, userid: "1", trailId: 102, date: "2025-09-21" },
          ],
        });
      }
      if (sql.includes("FROM trail_table")) {
        return Promise.resolve({
          rows: [
            { trailId: 101, name: "Trail A", difficulty: "easy" },
            { trailId: 102, name: "Trail B", difficulty: "medium" },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app).get("/profile/completed-hikes/1");
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty("completed_hike_table");
    expect(res.body).toHaveProperty("trail");
    expect(res.body.completed_hike_table).toHaveLength(2);
    expect(res.body.trail).toHaveLength(2);
    expect(res.body.completed_hike_table[0]).toMatchObject({
      hikeId: 1,
      userid: "1",
      trailId: 101,
      date: "2025-09-20",
    });
    expect(res.body.trail[0]).toMatchObject({
      trailId: 101,
      name: "Trail A",
      difficulty: "easy",
    });
  });
  test("GET /completed-global/:id returns completed global achievements", async () => {
    pool.query.mockImplementation((sql, params) => {
      if (sql.includes("FROM achievements_table")) {
        return Promise.resolve({
          rows: [
            {
              id: 301,
              title: "Achievement 1",
              description: "Complete 50km hiking",
              target: 50,
              current: 50,
            },
            {
              id: 302,
              title: "Achievement 2",
              description: "Climb 5 mountains",
              target: 5,
              current: 5,
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app).get("/completed-global/1");
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty("rows");
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[0]).toMatchObject({
      id: 301,
      title: "Achievement 1",
      description: "Complete 50km hiking",
      target: 50,
      current: 50,
    });
    expect(res.body.rows[1]).toMatchObject({
      id: 302,
      title: "Achievement 2",
      description: "Climb 5 mountains",
      target: 5,
      current: 5,
    });
  });
  describe("Completed Goals Endpoints", () => {
    beforeEach(() => {
      pool.query = jest.fn();
    });
    test("GET /profile/completed-global/:id returns completed global goals", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 501,
            title: "Global Achievement 1",
            description: "Run 50km",
            target: 50,
            current: 50,
          },
          {
            id: 502,
            title: "Global Achievement 2",
            description: "Climb 3 mountains",
            target: 3,
            current: 3,
          },
        ],
      });
      const res = await request(app).get("/profile/completed-global/1");
      expect(res.statusCode).toBe(200);
      expect(res.body.goals).toHaveLength(2);
      expect(res.body.goals[0]).toMatchObject({
        id: 501,
        title: "Global Achievement 1",
        description: "Run 50km",
        target: 50,
        current: 50,
        source: "global",
      });
    });
    test("GET /profile/completed-global/:id handles DB error", async () => {
      pool.query.mockRejectedValueOnce(new Error("DB failure"));
      const res = await request(app).get("/profile/completed-global/1");
      expect(res.statusCode).toBe(500);
      expect(res.body).toHaveProperty(
        "error",
        "Failed to fetch completed global goals"
      );
    });
    test("GET /profile/completed-personal/:id returns completed personal goals", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 601,
            title: "Personal Goal 1",
            description: "Do task 1",
            done: true,
          },
          {
            id: 602,
            title: "Personal Goal 2",
            description: "Do task 2",
            done: true,
          },
        ],
      });
      const res = await request(app).get("/profile/completed-personal/1");
      expect(res.statusCode).toBe(200);
      expect(res.body.goals).toHaveLength(2);
      expect(res.body.goals[0]).toMatchObject({
        id: 601,
        title: "Personal Goal 1",
        description: "Do task 1",
        current: 1,
        target: 1,
        done: true,
        source: "personal",
      });
    });
    test("GET /profile/completed-personal/:id handles DB error", async () => {
      pool.query.mockRejectedValueOnce(new Error("DB failure"));
      const res = await request(app).get("/profile/completed-personal/1");
      expect(res.statusCode).toBe(500);
      expect(res.body).toHaveProperty(
        "error",
        "Failed to fetch completed personal goals"
      );
    });
  });
  describe("POST /profile/add-goal/:id", () => {
    beforeEach(() => {
      pool.query = jest.fn();
    });
    test("adds a new goal successfully", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 701,
            title: "New Goal",
            description: "Do something",
            done: false,
          },
        ],
      });
      const res = await request(app)
        .post("/profile/add-goal/1")
        .send({ title: "New Goal", description: "Do something" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty("goal");
      expect(res.body.goal).toMatchObject({
        id: 701,
        title: "New Goal",
        description: "Do something",
        current: 0,
        target: 1,
        done: false,
        source: "personal",
      });
    });
    test("returns 400 if title or description missing", async () => {
      const res = await request(app)
        .post("/profile/add-goal/1")
        .send({ title: "Only Title" });
      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty(
        "error",
        "Title and description are required"
      );
    });
    test("handles DB errors gracefully", async () => {
      pool.query.mockRejectedValueOnce(new Error("DB failure"));
      const res = await request(app)
        .post("/profile/add-goal/1")
        .send({ title: "New Goal", description: "Do something" });
      expect(res.statusCode).toBe(500);
      expect(res.body).toHaveProperty("error", "Failed to add goal");
    });
  });
  describe("PUT /profile/edit-goal/:goalId/:id", () => {
    beforeEach(() => {
      pool.query = jest.fn();
    });
    test("updates a goal successfully", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 801,
            title: "Updated Goal",
            description: "Updated description",
            done: false,
          },
        ],
      });
      const res = await request(app)
        .put("/profile/edit-goal/801/1")
        .send({ title: "Updated Goal", description: "Updated description" });
      expect(res.statusCode).toBe(200);
      expect(res.body.goal).toMatchObject({
        id: 801,
        title: "Updated Goal",
        description: "Updated description",
        done: false,
      });
    });
    test("returns 400 if title or description is empty", async () => {
      const res = await request(app)
        .put("/profile/edit-goal/801/1")
        .send({ title: "", description: " " });
      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty(
        "error",
        "Title and description cannot be empty."
      );
    });
    test("returns 404 if goal not found", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });
      const res = await request(app)
        .put("/profile/edit-goal/999/1")
        .send({ title: "Goal", description: "Desc" });

      expect(res.statusCode).toBe(404);
      expect(res.body).toHaveProperty("error", "Goal not found");
    });
    test("handles DB errors gracefully", async () => {
      pool.query.mockRejectedValueOnce(new Error("DB failure"));
      const res = await request(app)
        .put("/profile/edit-goal/801/1")
        .send({ title: "Updated Goal", description: "Updated description" });
      expect(res.statusCode).toBe(500);
      expect(res.body).toHaveProperty("error", "Failed to update goal");
    });
  });
  describe("GET /users/search", () => {
    beforeEach(() => {
      pool.query = jest.fn();
    });
    test("returns 400 if username query missing", async () => {
      const res = await request(app).get("/users/search");
      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty("error", "Username query is required");
    });
    test("returns matched users from Clerk with internal IDs", async () => {
      // Mock Clerk
      const clerkMockUsers = [
        {
          id: "user_abc123",
          username: "alice123",
          imageUrl: "http://example.com/alice.png",
        },
        {
          id: "user_xyz456",
          username: "bob456",
          imageUrl: "http://example.com/bob.png",
        },
      ];
      jest
        .spyOn(clerkClient.users, "getUserList")
        .mockResolvedValueOnce(clerkMockUsers);
      pool.query.mockImplementation((sql, params) => {
        if (params[0] === "user_abc123") return { rows: [{ userid: 1 }] };
        if (params[0] === "user_xyz456") return { rows: [{ userid: 2 }] };
        return { rows: [] };
      });
      const res = await request(app)
        .get("/users/search")
        .query({ username: "alice123" });

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty("users");
      expect(res.body.users).toEqual([
        {
          id: 1,
          username: "alice123",
          imageUrl: "http://example.com/alice.png",
        },
      ]);
    });
    test("handles Clerk or DB errors gracefully", async () => {
      jest
        .spyOn(clerkClient.users, "getUserList")
        .mockRejectedValueOnce(new Error("Clerk failure"));
      const res = await request(app)
        .get("/users/search")
        .query({ username: "alice123" });
      expect(res.statusCode).toBe(500);
      expect(res.body).toHaveProperty("error", "Failed to search users");
    });
  });
  describe("GET /users/random", () => {
    beforeAll(() => {
      pool.query = jest.fn((sql, params) => {
        if (sql.includes("FROM follow_table")) {
          return { rows: [{ userID2: 2 }] };
        }
        if (sql.includes("FROM usertable")) {
          return {
            rows: [
              { authid: "user_xyz456", userid: 3 },
              { authid: "user_abc123", userid: 4 },
            ],
          };
        }
        return { rows: [] };
      });
      const { clerkClient } = require("@clerk/clerk-sdk-node");
      clerkClient.users.getUser.mockImplementation(async (authid) => {
        if (authid === "user_abc123") {
          return {
            id: authid,
            username: "alice123",
            firstName: "Alice",
            lastName: "A",
            imageUrl: "http://example.com/alice.png",
          };
        }
        if (authid === "user_xyz456") {
          return {
            id: authid,
            username: "bob456",
            firstName: "Bob",
            lastName: "B",
            imageUrl: "http://example.com/bob.png",
          };
        }
        throw new Error("User not found");
      });
    });
    test("returns 400 if currentUserId is missing", async () => {
      const res = await request(app).get("/users/random");
      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty("error", "currentUserId is required");
    });
    test("returns random users excluding current user and followed", async () => {
      const res = await request(app).get(
        "/users/random?currentUserId=1&limit=2"
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty("users");
      expect(res.body.users.length).toBeGreaterThan(0);
      const userIds = res.body.users.map((u) => u.id);
      expect(userIds).not.toContain(1);
      expect(userIds).not.toContain(2);
      expect(res.body.users[0]).toMatchObject({
        id: expect.any(Number),
        username: expect.any(String),
        firstName: expect.any(String),
        lastName: expect.any(String),
        imageUrl: expect.any(String),
      });
    });
  });
  describe("POST /follow/:id", () => {
    beforeAll(() => {
      pool.query = jest.fn((sql, params) => {
        if (sql.includes("SELECT * FROM follow_table")) {
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO follow_table")) {
          return { rows: [{ userID1: params[0], userID2: params[1] }] };
        }
        return { rows: [] };
      });
    });
    test("should return 400 if followerId or followeeId missing", async () => {
      const res = await request(app).post("/follow/1").send({});
      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty(
        "error",
        "Follower and followee IDs required"
      );
    });
    test("should return 400 if user tries to follow themselves", async () => {
      const res = await request(app).post("/follow/1").send({ followerId: 1 });
      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty("error", "Cannot follow yourself");
    });
    test("should return 400 if already following", async () => {
      pool.query.mockImplementationOnce(() => ({
        rows: [{ userID1: 1, userID2: 2 }],
      }));
      const res = await request(app).post("/follow/2").send({ followerId: 1 });
      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty("error", "Already following this user");
    });
    test("should follow user successfully", async () => {
      const res = await request(app).post("/follow/2").send({ followerId: 1 });
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty("message", "Followed successfully");
      expect(res.body.follow).toMatchObject({ userID1: 1, userID2: 2 });
    });
  });
  describe("DELETE /follow/:id", () => {
    beforeAll(() => {
      pool.query = jest.fn((sql, params) => {
        if (sql.includes("DELETE FROM follow_table")) {
          const [followerId, followeeId] = params;
          if (followerId === 1 && followeeId === 2) {
            return { rows: [{ userID1: 1, userID2: 2 }] };
          }
          return { rows: [] };
        }
        return { rows: [] };
      });
    });
    test("should return 400 if followerId or followeeId missing", async () => {
      const res = await request(app).delete("/follow/1").send({});
      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty(
        "error",
        "Follower and followee IDs required"
      );
    });
    test("should return 404 if follow relationship not found", async () => {
      const res = await request(app)
        .delete("/follow/999")
        .send({ followerId: 1 });
      expect(res.statusCode).toBe(404);
      expect(res.body).toHaveProperty("error", "Follow relationship not found");
    });
    test("should successfully unfollow user", async () => {
      const res = await request(app)
        .delete("/follow/2")
        .send({ followerId: 1 });
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty("message", "Unfollowed successfully");
      expect(res.body.follow).toEqual({ userID1: 1, userID2: 2 });
    });
  });
  test("should return 500 if DB throws an error", async () => {
    pool.query.mockRejectedValueOnce(new Error("DB failure"));
    const res = await request(app).post("/follow/2").send({ followerId: 1 });
    expect(res.statusCode).toBe(500);
    expect(res.body).toHaveProperty("error", "Failed to follow user");
  });
  describe("PUT /profile/mark-done/:goalId/:userId", () => {
    const goalId = 1;
    const userId = 1;
    test("marks a goal as done successfully", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [
          { id: goalId, title: "Test Goal", description: "Desc", done: true },
        ],
      });

      const res = await request(app).put(
        `/profile/mark-done/${goalId}/${userId}`
      );

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty("message", "Goal marked as done");
      expect(res.body.goal).toMatchObject({
        id: goalId,
        title: "Test Goal",
        description: "Desc",
        done: true,
        current: 1,
        target: 1,
        source: "personal",
      });
    });
    test("returns 404 if goal not found", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });
      const res = await request(app).put(
        `/profile/mark-done/${goalId}/${userId}`
      );
      expect(res.statusCode).toBe(404);
      expect(res.body).toHaveProperty(
        "error",
        "Goal not found or not owned by user"
      );
    });
    test("returns 500 if DB throws an error", async () => {
      pool.query.mockRejectedValueOnce(new Error("DB failure"));
      const res = await request(app).put(
        `/profile/mark-done/${goalId}/${userId}`
      );
      expect(res.statusCode).toBe(500);
      expect(res.body).toHaveProperty("error", "Failed to mark goal as done");
    });
  });
  describe("DELETE /profile/edit-goal/:goalId/:userId", () => {
    test("successfully deletes a goal", async () => {
      const goalId = 1;
      const userId = 2;
      pool.query.mockResolvedValueOnce({ rows: [{ gid: goalId }] });
      const res = await request(app).delete(
        `/profile/edit-goal/${goalId}/${userId}`
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty("deletedGoalId", goalId);
    });
    test("returns 404 if goal not found", async () => {
      const goalId = 1;
      const userId = 2;
      pool.query.mockResolvedValueOnce({ rows: [] });
      const res = await request(app).delete(
        `/profile/edit-goal/${goalId}/${userId}`
      );
      expect(res.statusCode).toBe(404);
      expect(res.body).toHaveProperty(
        "error",
        "Goal not found or not owned by user"
      );
    });
    test("handles DB error", async () => {
      const goalId = 1;
      const userId = 2;
      const consoleSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      pool.query.mockRejectedValueOnce(new Error("DB failure"));
      const res = await request(app).delete(
        `/profile/edit-goal/${goalId}/${userId}`
      );
      expect(res.statusCode).toBe(500);
      expect(res.body).toHaveProperty("error", "Failed to delete goal");
      expect(consoleSpy).toHaveBeenCalledWith(
        "Error deleting goal:",
        expect.any(Error)
      );
      consoleSpy.mockRestore();
    });
  });
  describe("GET /users/random", () => {
    test("handles DB errors and logs them", async () => {
      const consoleSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      pool.query.mockRejectedValueOnce(new Error("DB failure"));
      const res = await request(app)
        .get("/users/random")
        .query({ currentUserId: 1 });
      expect(res.statusCode).toBe(500);
      expect(res.body).toHaveProperty("error", "Failed to fetch random users");
      expect(consoleSpy).toHaveBeenCalledWith(
        "Error fetching random users:",
        expect.any(Error)
      );
      consoleSpy.mockRestore();
    });
  });
  describe("DELETE /follow/:id", () => {
    test("logs error and returns 500 if DB throws", async () => {
      const consoleSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      pool.query.mockRejectedValueOnce(new Error("DB failure"));
      const res = await request(app)
        .delete("/follow/2")
        .send({ followerId: 1 });
      expect(res.statusCode).toBe(500);
      expect(res.body).toHaveProperty("error", "Failed to unfollow user");
      expect(consoleSpy).toHaveBeenCalledWith(
        "Error unfollowing user:",
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });
  });
  describe("GET /profile/completed-hikes/:id", () => {
    test("logs error and returns 500 if DB throws", async () => {
      const consoleSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      pool.query.mockRejectedValueOnce(new Error("DB failure"));
      const res = await request(app).get("/profile/completed-hikes/1");
      expect(res.statusCode).toBe(500);
      expect(res.body).toHaveProperty(
        "error",
        "Failed to fetch completed hikes"
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        "Error fetching completed hikes:",
        expect.any(Error)
      );
      consoleSpy.mockRestore();
    });
  });
  describe("GET /profile/completed-personal/:id", () => {
    test("logs error and returns 500 if DB throws", async () => {
      const consoleSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      pool.query.mockRejectedValueOnce(new Error("DB failure"));
      const res = await request(app).get("/profile/completed-personal/1");
      expect(res.statusCode).toBe(500);
      expect(res.body).toHaveProperty(
        "error",
        "Failed to fetch completed personal goals"
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        "Error fetching completed personal goals:",
        expect.any(Error)
      );
      consoleSpy.mockRestore();
    });
  });
  describe("GET /profile/global-goals/:userId", () => {
    test("logs error and returns 500 if DB throws", async () => {
      const consoleSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      pool.query.mockRejectedValueOnce(new Error("DB failure"));
      const res = await request(app).get("/profile/global-goals/1");
      expect(res.statusCode).toBe(500);
      expect(res.body).toHaveProperty("error", "Failed to fetch global goals");
      expect(consoleSpy).toHaveBeenCalledWith(
        "Error fetching global goals:",
        expect.any(Error)
      );
      consoleSpy.mockRestore();
    });
  });
});
