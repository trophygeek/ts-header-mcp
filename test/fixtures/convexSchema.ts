/**
 * Fixture shaped like a Convex schema: the file's only export is
 * a default-exported schema call (default-export extraction tests).
 */

function defineTable(shape: Record<string, unknown>) {
  return shape;
}

function defineSchema(tables: Record<string, unknown>) {
  return tables;
}

export default defineSchema({
  bookings: defineTable({
    profileId: "string",
    spotId: "string",
    status: "string",
  }),
  schedules: defineTable({
    day: "string",
    openTime: "number",
  }),
  profiles: defineTable({
    name: "string",
  }),
});