# Case study: ts_header vs. grep-driven exploration

We ran the same query — *“Explain how waitlist queues work in this project”* — over a large, complex monorepo in two sessions. One session had the `ts_header` tool available; the other did not. Both used the same LLM (Gemini Flash 3.5) in the Antigravity IDE.

## Summary

| Dimension | Session 1 (no `ts_header`) | Session 2 (with `ts_header`) |
| :--- | :--- | :--- |
| **Initial discovery strategy** | Unfiltered `grep_search("waitlist")` (200 matches) | Structured `ts_header` directory scan & filter |
| **Module coverage** | Found 4 key files; missed `convex/convex/bookingsCheckIn.ts` and `convex/convex/bookingsNotifications.ts` | Found all 5 waitlist-related files across `convex/` and `domain/` |
| **Tool execution efficiency** | Trial-and-error grepping + full-file viewing | Hierarchical: directory overview → filtered signatures → targeted line views |
| **Explanation completeness** | Solid overview of placement, offering, claiming, and expiration | Complete end-to-end trace, including admin no-show spot releases and background notifications |

## Detailed comparison

### 1. Information discovery and signal-to-noise ratio

**Session 1 strategy:**

1. `grep_search("waitlist")` — 200 matches across the web app, admin app, tests, and docs.
2. `view_file` on `bookingsWaitlist.ts` (entire 373 lines at once).
3. `grep_search("offerSpotToWaitlist")`.
4. `view_file` on `bookingRules.ts`.
5. `grep_search('bookingStatus: "waitlisted"')` — 0 matches due to quote formatting.
6. `view_file` on `bookings.ts`.

*Drawbacks*: high noise level, unstructured exploration, and redundant view calls.

**Session 2 strategy:**

1. `ts_header(".")` — identified the major modules (`apps/`, `convex/`, `domain/`, `tooling/`).
2. `ts_header(".", { filter: "waitlist" })` — immediately returned the exact matching files:
   - `convex/bookingsCheckIn.ts` (`releaseSpotToWaitlist`)
   - `convex/bookingsNotifications.ts` (`sendWaitlistOfferNotification`)
   - `convex/bookingsWaitlist.ts` (`offerSpotToWaitlist`)
   - `domain/src/bookingRules.ts` (`selectNextWaitlisted`)
3. `ts_header([files...])` — fetched line-numbered signatures for all exported functions before viewing any source.
4. `view_file` — targeted exact line ranges (e.g. lines 138–172 in `bookingsCheckIn.ts`).

*Advantages*: high signal-to-noise ratio, no wasted lines, and a clean mental model of the function contracts up front.

### 2. Output accuracy and completeness

**Session 1** accurately described queue entry (`domain/src/bookingRules.ts#L25`), `offerSpotToWaitlist`, `acceptOffer`, `declineOffer`, and `expireOffer`. However, it missed how admin check-in releases (`releaseSpotToWaitlist` in `convex/convex/bookingsCheckIn.ts#L138`) and reallocation hooks (`convex/convex/reallocation.ts#L38`) trigger the queue offering flow.

**Session 2** produced a more thorough explanation because `ts_header` surfaced every entry point into the waitlist system across the monorepo, explicitly covering:

- Admin no-show spot releases (`releaseSpotToWaitlist` in `convex/convex/bookingsCheckIn.ts#L138`).
- Automated waitlist offer notifications (`sendWaitlistOfferNotification` in `convex/convex/bookingsNotifications.ts#L6`).
- Integration with spot reallocation optimization (`optimizeSchedule` in `convex/convex/reallocation.ts#L12`).

## Evaluation

Session 2 was significantly stronger on two axes:

1. **Efficiency** — top-down, index-driven discovery instead of trial-and-error text grepping.
2. **Completeness** — it discovered and incorporated entry points (notifications, check-in releases) that Session 1 overlooked.