jest.setTimeout(60000); // 60 seconds for all tests

// ------------------------
// 1. MOCK CLERK BEFORE SERVER IMPORT
// ------------------------
jest.mock("@clerk/clerk-sdk-node", () => {
  return {
    clerkClient: {
      users: {
        getUser: jest.fn(async (authid) => {
          if (authid === "user_abc123") return {
            id: authid,
            primaryEmailAddress: { emailAddress: "alice@example.com" },
            firstName: "Alice",
            lastName: "A",
            username: "alice123",
            imageUrl: "http://example.com/alice.png",
          };
          if (authid === "user_xyz456") return {
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
// 2. IMPORT SERVER AFTER MOCK
// ------------------------
const request = require("supertest");
const { app, pool } = require("../server");

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
  });
});
